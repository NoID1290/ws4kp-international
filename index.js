// cors pass through
const fs = require('fs');
const path = require('path');

const express = require('express');

const app = express();
const port = process.env.WS4KP_PORT ?? 6969;

// Store RequestValidator when loaded
let RequestValidator;

// Store WeatherUndergroundPwsMapper when loaded
let WeatherUndergroundPwsMapper;

// Store Streamer when loaded
let Streamer;


// Load the ES module
import('./server/scripts/modules/utils/requestValidator.mjs')
	.then((module) => {
		RequestValidator = module.default || module;
	})
	.catch((err) => {
		console.error('Failed to load RequestValidator:', err);
		process.exit(1);
	});

import('./server/scripts/modules/utils/weatherUndergroundPwsMapper.mjs')
	.then((module) => {
		WeatherUndergroundPwsMapper = module.default || module;
	})
	.catch((err) => {
		console.error('Failed to load WeatherUndergroundPwsMapper.mjs:', err);
		process.exit(1);
	});

import('./server/streamer.mjs')
	.then((module) => {
		Streamer = module;
		if (Streamer && typeof Streamer.startStreamer === 'function') {
			Streamer.startStreamer(port);
		}
	})
	.catch((err) => {
		console.error('Failed to load streamer.mjs:', err);
	});

// template engine
app.set('view engine', 'ejs');

// parse JSON and urlencoded bodies for POST requests
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory store for the latest pushed data (keeps things simple for local runs)
let latestWeather = null;

// SSE clients set
const sseClients = new Set();

// serve generated HLS streams
app.use('/stream', express.static(path.join(__dirname, './server/stream')));

// IPTV playlist
app.get('/stream/playlist.m3u', (req, res) => {
	const host = req.headers.host || `localhost:${port}`;
	const playlist = `#EXTM3U\n#EXTINF:-1 tvg-id="ws4kp" tvg-name="WeatherStar 4000" group-title="Weather",WeatherStar 4000\nhttp://${host}/stream/index.m3u8\n`;
	res.setHeader('Content-Type', 'application/x-mpegurl');
	res.send(playlist);
});

// version
const { version } = JSON.parse(fs.readFileSync('package.json'));

const index = (req, res) => {
	res.render(path.join(__dirname, 'views/index'), {
		production: false,
		version,
		// pass bootstrapped initial data to the page (stringified for safe insertion)
		// initialData: JSON.stringify(latestWeather),
	});
};

// Proxy for Wikipedia API
app.get('/proxy/wikipedia', async (req, res) => {
	try {
		const targetUrl = `https://en.wikipedia.org/w/api.php?${new URLSearchParams(req.query).toString()}`;
		const response = await fetch(targetUrl, {
			headers: { 'User-Agent': 'ws4kp-quebec/1.0 (https://github.com/mwood77/ws4kp-international)' }
		});
		const data = await response.json();
		res.setHeader('Content-Type', 'application/json');
		res.send(data);
	} catch (error) {
		console.error('Wikipedia proxy error:', error);
		res.status(500).json({ error: error.message });
	}
});

// Proxy for Wikidata EntityData
app.get('/proxy/wikidata-entity/:cityCode', async (req, res) => {
	try {
		const targetUrl = `https://www.wikidata.org/wiki/Special:EntityData/${req.params.cityCode}.json`;
		const response = await fetch(targetUrl, {
			headers: { 'User-Agent': 'ws4kp-quebec/1.0 (https://github.com/mwood77/ws4kp-international)' }
		});
		const data = await response.json();
		res.setHeader('Content-Type', 'application/json');
		res.send(data);
	} catch (error) {
		console.error('Wikidata entity proxy error:', error);
		res.status(500).json({ error: error.message });
	}
});

// Proxy for Wikidata SPARQL
app.get('/proxy/wikidata-sparql', async (req, res) => {
	try {
		const targetUrl = `https://query.wikidata.org/sparql?${new URLSearchParams(req.query).toString()}`;
		const response = await fetch(targetUrl, {
			headers: {
				Accept: 'application/sparql-results+json',
				'User-Agent': 'ws4kp-quebec/1.0 (https://github.com/mwood77/ws4kp-international)'
			}
		});
		const data = await response.json();
		res.setHeader('Content-Type', 'application/json');
		res.send(data);
	} catch (error) {
		console.error('Wikidata SPARQL proxy error:', error);
		res.status(500).json({ error: error.message });
	}
});

// debugging
if (process.env?.DIST === '1') {
	// distribution
	app.use('/images', express.static(path.join(__dirname, './server/images')));
	app.use('/fonts', express.static(path.join(__dirname, './server/fonts')));
	app.use('/scripts', express.static(path.join(__dirname, './server/scripts')));
	app.use('/', express.static(path.join(__dirname, './dist')));
} else {
	// debugging
	app.get('/index.html', index);
	app.get('/', index);
	app.get('*', express.static(path.join(__dirname, './server')));
}

// app.post('/v1/ecowitt', (req, res) => {
// 	// accept JSON body from local tools or other containers
// 	const payload = req.body;

// 	// validate payload
// 	if (!RequestValidator.isValidEcowittStyleBody(payload)) {
// 		const gotKeys = Object.keys(payload || {}).join(', ');
// 		const requiredKeys = RequestValidator.validWeatherBodyKeys.join(', ');

// 		console.log(`Invalid weather body received. Got keys: ${gotKeys}`);

// 		res.status(400)
// 			.setHeader('Content-Type', 'application/json')
// 			.json(
// 				{
// 					status: 'error',
// 					message: 'Invalid weather data body. It must be a flat object with requiredKeys.',
// 					gotKeys,
// 					requiredKeys,
// 				},
// 			);
// 		return;
// 	}

// 	// store latest data so newly loaded pages can bootstrap it
// 	latestWeather = payload;

// 	// broadcast to connected SSE clients
// 	const dataString = JSON.stringify({ type: 'weather-update', payload: latestWeather });
// 	sseClients.forEach((clientRes) => {
// 		try {
// 			clientRes.write(`data: ${dataString}\n\n`);
// 		} catch (e) {
// 			// ignore broken clients; they'll be cleaned on close
// 		}
// 	});

// 	res.setHeader('Content-Type', 'application/json');
// 	res.status(200).json({ status: 'ok', received: payload });
// });

app.get('/v1/pws', (req, res) => {
	// accept JSON body from local tools or other containers
	const payload = req.query;

	// validate payload
	if (!RequestValidator.isValidWuPwsRequest(payload)) {
		const gotKeys = Object.keys(payload || {}).join(', ');
		const requiredKeys = RequestValidator.validPwsRequestKeys.join(', ');

		res.status(400)
			.setHeader('Content-Type', 'application/json')
			.json(
				{
					status: 'error',
					message: 'Invalid weather data query params. It must be url encoded with requiredKeys.',
					gotKeys,
					requiredKeys,
				},
			);
		return;
	}

	// store latest data so newly loaded pages can bootstrap it
	latestWeather = WeatherUndergroundPwsMapper.mapsPWSRequestToWeatherBody(payload);

	// broadcast to connected SSE clients
	const dataString = JSON.stringify({ type: 'weather-update', payload: latestWeather });
	sseClients.forEach((clientRes) => {
		try {
			clientRes.write(`data: ${dataString}\n\n`);
		} catch (e) {
			// ignore broken clients; they'll be cleaned on close
		}
	});

	res.setHeader('Content-Type', 'application/text');
	res.send('success');
});

// Server-Sent Events endpoint for pushing updates to the webapp
app.get('/events', (req, res) => {
	// set required headers for SSE
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		Connection: 'keep-alive',
	});

	// send a comment to keep the connection alive
	res.write(': connected\n\n');

	// if we already have data, send it immediately
	if (latestWeather !== null) {
		const initString = JSON.stringify({ type: 'weather-update', payload: latestWeather });
		res.write(`data: ${initString}\n\n`);
	}

	// add to clients
	sseClients.add(res);

	// remove client when connection closes
	req.on('close', () => {
		sseClients.delete(res);
	});
});

const server = app.listen(port, () => {
	console.log(`Server listening on port ${port}`);
});

// graceful shutdown
const gracefulShutdown = async () => {
	console.log('Graceful shutdown initiated...');
	// Force exit after 1.5 seconds if shutdown hangs (nodemon timeout is typically 1s)
	const forceExitTimeout = setTimeout(() => {
		console.log('Shutdown timed out, forcing exit.');
		process.exit(0);
	}, 1500);

	try {
		if (Streamer && typeof Streamer.stopStreamer === 'function') {
			await Streamer.stopStreamer();
		}
	} catch (err) {
		console.error('Error stopping streamer:', err);
	}

	server.close(() => {
		console.log('Server closed');
		clearTimeout(forceExitTimeout);
		process.exit(0);
	});
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('SIGUSR2', gracefulShutdown); // Handle nodemon restart
