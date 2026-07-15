import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import puppeteer from 'puppeteer';

let browser = null;
let ffmpegProcess = null;
let captureTimeout = null;
let running = false;

// Helper to convert environment variables to correct types
const parseEnvBool = (val) => {
	if (val === undefined) return undefined;
	return val.toLowerCase() === 'true' || val === '1';
};

const parseEnvInt = (val) => {
	if (val === undefined) return undefined;
	const parsed = parseInt(val, 10);
	return isNaN(parsed) ? undefined : parsed;
};

const writeToFfmpegStdin = (process, buffer) => new Promise((resolve) => {
	if (process.stdin.write(buffer)) {
		resolve();
	} else {
		process.stdin.once('drain', resolve);
	}
});

const checkFfmpegEncoder = (codec, ffmpegPath) => {
	return new Promise((resolve) => {
		const proc = spawn(ffmpegPath, ['-encoders']);
		let output = '';
		proc.stdout.on('data', (data) => { output += data.toString(); });
		proc.on('close', () => {
			resolve(output.toLowerCase().includes(codec.toLowerCase()));
		});
		proc.on('error', () => resolve(false));
	});
};

export async function startStreamer(port) {
	const configPath = path.resolve('./server/config/stream.json');
	let config = {
		enabled: false,
		url: 'http://localhost:WS4KP_PORT/?kiosk=true',
		fps: 15,
		width: 640,
		height: 480,
		audioEnabled: true,
		ffmpegVideoCodec: 'h264_nvenc',
		ffmpegPreset: 'veryfast',
		ffmpegPath: 'ffmpeg',
		jpegQuality: 80,
		hlsSegmentDuration: 2,
		hlsListSize: 5,
		ffmpegAudioSource: 'anullsrc',
	};

	// Read stream.json config if it exists
	if (fs.existsSync(configPath)) {
		try {
			const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
			config = { ...config, ...fileConfig };
		} catch (err) {
			console.error('Failed to parse stream.json config:', err.message);
		}
	}

	// Environment variable overrides
	config.enabled = parseEnvBool(process.env.STREAM_ENABLED) ?? config.enabled;
	config.url = process.env.STREAM_URL ?? config.url;
	config.fps = parseEnvInt(process.env.STREAM_FPS) ?? config.fps;
	config.width = parseEnvInt(process.env.STREAM_WIDTH) ?? config.width;
	config.height = parseEnvInt(process.env.STREAM_HEIGHT) ?? config.height;
	config.audioEnabled = parseEnvBool(process.env.STREAM_AUDIO_ENABLED) ?? config.audioEnabled;
	config.ffmpegVideoCodec = process.env.STREAM_FFMPEG_VIDEO_CODEC ?? config.ffmpegVideoCodec;
	config.ffmpegPreset = process.env.STREAM_FFMPEG_PRESET ?? config.ffmpegPreset;
	config.ffmpegPath = process.env.STREAM_FFMPEG_PATH ?? config.ffmpegPath;
	config.ffmpegAudioSource = process.env.STREAM_FFMPEG_AUDIO_SOURCE ?? config.ffmpegAudioSource;
	const codecs = config.ffmpegVideoCodec.split(',').map((c) => c.trim()).filter(Boolean);
	let selectedCodec = null;
	for (const codec of codecs) {
		const encoderAvailable = await checkFfmpegEncoder(codec, config.ffmpegPath);
		if (encoderAvailable) {
			selectedCodec = codec;
			break;
		} else {
			console.log(`Encoder '${codec}' not available in FFmpeg build.`);
		}
	}
	if (!selectedCodec) {
		console.log('No configured encoders available, falling back to libx264.');
		selectedCodec = 'libx264';
	}
	config.ffmpegVideoCodec = selectedCodec;

	if (!config.enabled) {
		console.log('Background streamer is disabled in configuration.');
		return;
	}

	// Resolve the kiosk URL (replacing WS4KP_PORT placeholder if it exists)
	const resolvedUrl = config.url.replace('WS4KP_PORT', String(port));
	console.log(`Starting background streamer...\n- URL: ${resolvedUrl}\n- Size: ${config.width}x${config.height}\n- FPS: ${config.fps}\n- Codec: ${config.ffmpegVideoCodec}`);

	// Wait 5 seconds to let the server start up and listen
	await new Promise((resolve) => setTimeout(resolve, 5000));

	running = true;

	try {
		// Ensure HLS stream directory exists
		const hlsOutputDir = path.resolve('./server/stream');
		if (fs.existsSync(hlsOutputDir)) {
			// Clean up old segments on startup
			fs.readdirSync(hlsOutputDir).forEach((file) => {
				if (file.endsWith('.ts') || file.endsWith('.m3u8')) {
					try {
						fs.unlinkSync(path.join(hlsOutputDir, file));
					} catch (e) { }
				}
			});
		} else {
			fs.mkdirSync(hlsOutputDir, { recursive: true });
		}

		const puppeteerArgs = [
			'--no-sandbox',
			'--disable-setuid-sandbox',
			'--disable-dev-shm-usage',
			'--disable-gpu',
			'--hide-scrollbars',
			'--font-render-hinting=none',
			'--disable-background-timer-throttling',
			'--disable-backgrounding-occluded-windows',
			'--disable-renderer-backgrounding',
		];
		if (!config.ffmpegAudioSource || !config.ffmpegAudioSource.startsWith('audio=')) {
			puppeteerArgs.push('--mute-audio');
		}

		// Launch headless browser
		browser = await puppeteer.launch({
			headless: true,
			args: puppeteerArgs,
			executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
		});

		const page = await browser.newPage();
		page.on('console', (msg) => console.log(`[PUPPETEER PAGE LOG] ${msg.text()}`));
		page.on('pageerror', (err) => console.error(`[PUPPETEER PAGE ERROR] ${err.message}`));
		await page.setViewport({ width: config.width, height: config.height });

		console.log('Opening viewport in headless browser...');
		await page.goto(resolvedUrl, { waitUntil: 'networkidle2' });

		// Extra wait to let animations settle
		await new Promise((resolve) => setTimeout(resolve, 2000));

		// Set up FFmpeg HLS args
		const ffmpegArgs = [
			'-y',
			'-f', 'image2pipe',
			'-vcodec', 'mjpeg',
			'-framerate', String(config.fps),
			'-i', '-',
		];

		if (config.audioEnabled) {
			const isNullSource = !config.ffmpegAudioSource || config.ffmpegAudioSource === 'anullsrc';
			if (isNullSource) {
				ffmpegArgs.push(
					'-f',
					'lavfi',
					'-i',
					'anullsrc=channel_layout=stereo:sample_rate=44100',
					'-c:a',
					'aac',
				);
			} else if (config.ffmpegAudioSource.startsWith('audio=')) {
				// Hardware system audio loopback capture
				ffmpegArgs.push(
					'-f', 'dshow',
					'-i', config.ffmpegAudioSource,
					'-c:a', 'aac',
					'-map', '0:v',
					'-map', '1:a',
				);
			} else {
				// Local file or remote audio stream URL
				const isUrl = config.ffmpegAudioSource.startsWith('http://') || config.ffmpegAudioSource.startsWith('https://');
				if (!isUrl) {
					ffmpegArgs.push('-stream_loop', '-1');
				}
				ffmpegArgs.push(
					'-i', config.ffmpegAudioSource,
					'-c:a', 'aac',
					'-map', '0:v',
					'-map', '1:a',
				);
			}
		}

		let mappedPreset = config.ffmpegPreset;
		if (config.ffmpegVideoCodec.includes('nvenc')) {
			if (['ultrafast', 'superfast', 'veryfast'].includes(mappedPreset)) {
				mappedPreset = 'p1';
			} else if (mappedPreset === 'fast') {
				mappedPreset = 'p2';
			} else if (mappedPreset === 'medium') {
				mappedPreset = 'p4';
			} else if (['slow', 'slower', 'veryslow'].includes(mappedPreset)) {
				mappedPreset = 'p7';
			} else {
				mappedPreset = 'p4';
			}
		}

		ffmpegArgs.push(
			'-c:v',
			config.ffmpegVideoCodec,
			'-pix_fmt',
			'yuv420p',
			'-preset',
			mappedPreset,
		);

		if (config.ffmpegVideoCodec.startsWith('libx264')) {
			ffmpegArgs.push('-tune', 'zerolatency');
		}

		ffmpegArgs.push(
			'-g',
			String(config.fps * 2),
			'-keyint_min',
			String(config.fps * 2),
			'-sc_threshold',
			'0',
			'-hls_time',
			String(config.hlsSegmentDuration),
			'-hls_list_size',
			String(config.hlsListSize),
			'-hls_flags',
			'delete_segments+temp_file',
			path.join(hlsOutputDir, 'index.m3u8'),
		);

		console.log('Spawning FFmpeg...');
		ffmpegProcess = spawn(config.ffmpegPath, ffmpegArgs);

		ffmpegProcess.stderr.on('data', (data) => {
			// Uncomment for verbose FFmpeg debugging
			// console.log(`[FFMPEG STDERR] ${data}`);
		});

		ffmpegProcess.on('exit', (code, signal) => {
			console.log(`FFmpeg process exited with code ${code} and signal ${signal}`);
			if (running) {
				console.log('FFmpeg exited unexpectedly. Stopping stream loop...');
				stopStreamer();
			}
		});

		// Start CDP screencast session
		const client = await page.createCDPSession();
		client.on('Page.screencastFrame', async ({ data, sessionId }) => {
			if (!running) {
				try {
					await client.send('Page.screencastFrameAck', { sessionId });
				} catch (e) {}
				return;
			}

			try {
				const buffer = Buffer.from(data, 'base64');
				if (ffmpegProcess && ffmpegProcess.stdin.writable) {
					await writeToFfmpegStdin(ffmpegProcess, buffer);
				}
			} catch (err) {
				console.error('CDP Screencast frame processing failed:', err.message);
			} finally {
				try {
					await client.send('Page.screencastFrameAck', { sessionId });
				} catch (e) {}
			}
		});

		await client.send('Page.startScreencast', {
			format: 'jpeg',
			quality: config.jpegQuality,
			maxWidth: config.width,
			maxHeight: config.height,
			everyNthFrame: 1,
		});

		console.log('Background streamer running and encoding to HLS.');
	} catch (err) {
		console.error('Failed to initialize background streamer:', err);
		await stopStreamer();
	}
}

export async function stopStreamer() {
	console.log('Stopping background streamer...');
	running = false;

	if (captureTimeout) {
		clearTimeout(captureTimeout);
		captureTimeout = null;
	}

	if (ffmpegProcess) {
		try {
			ffmpegProcess.stdin.end();
			ffmpegProcess.kill('SIGINT');
		} catch (e) { }
		ffmpegProcess = null;
	}

	if (browser) {
		try {
			await browser.close();
		} catch (e) { }
		browser = null;
	}

	console.log('Background streamer stopped.');
}

// Global cleanup event listener
process.on('exit', () => {
	if (ffmpegProcess) {
		try { ffmpegProcess.kill('SIGKILL'); } catch (e) { }
	}
});
