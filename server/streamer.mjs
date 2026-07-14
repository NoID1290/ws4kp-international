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

export async function startStreamer(port) {
	const configPath = path.resolve('./server/config/stream.json');
	let config = {
		enabled: false,
		url: 'http://localhost:WS4KP_PORT/?kiosk=true',
		fps: 10,
		width: 640,
		height: 480,
		audioEnabled: true,
		ffmpegVideoCodec: 'libx264',
		ffmpegPreset: 'veryfast',
		ffmpegPath: 'ffmpeg',
		jpegQuality: 80,
		hlsSegmentDuration: 2,
		hlsListSize: 5
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
					} catch (e) {}
				}
			});
		} else {
			fs.mkdirSync(hlsOutputDir, { recursive: true });
		}

		// Launch headless browser
		browser = await puppeteer.launch({
			headless: true,
			args: [
				'--no-sandbox',
				'--disable-setuid-sandbox',
				'--disable-dev-shm-usage',
				'--disable-gpu',
				'--hide-scrollbars',
				'--mute-audio',
				'--font-render-hinting=none'
			],
			executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
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
			'-i', '-'
		];

		if (config.audioEnabled) {
			ffmpegArgs.push(
				'-f', 'lavfi',
				'-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
				'-c:a', 'aac',
				'-shortest'
			);
		}

		ffmpegArgs.push(
			'-c:v', config.ffmpegVideoCodec,
			'-pix_fmt', 'yuv420p',
			'-preset', config.ffmpegPreset,
			'-g', String(config.fps * 2), // keyframe every 2 seconds
			'-hls_time', String(config.hlsSegmentDuration),
			'-hls_list_size', String(config.hlsListSize),
			'-hls_flags', 'delete_segments',
			path.join(hlsOutputDir, 'index.m3u8')
		);

		console.log('Spawning FFmpeg...');
		ffmpegProcess = spawn(config.ffmpegPath, ffmpegArgs);

		ffmpegProcess.stderr.on('data', (data) => {
			// Uncomment for verbose FFmpeg debugging
			// console.log(`[FFMPEG] ${data}`);
		});

		ffmpegProcess.on('exit', (code, signal) => {
			console.log(`FFmpeg process exited with code ${code} and signal ${signal}`);
			if (running) {
				console.log('FFmpeg exited unexpectedly. Stopping stream loop...');
				stopStreamer();
			}
		});

		// Start screenshot piping loop
		const interval = 1000 / config.fps;
		const captureLoop = async () => {
			if (!running) return;
			const startTime = Date.now();

			try {
				const buffer = await page.screenshot({
					type: 'jpeg',
					quality: config.jpegQuality
				});

				if (ffmpegProcess && ffmpegProcess.stdin.writable) {
					ffmpegProcess.stdin.write(buffer);
				}
			} catch (err) {
				console.error('Screenshot capture failed:', err.message);
			}

			const elapsed = Date.now() - startTime;
			const delay = Math.max(1, interval - elapsed);
			captureTimeout = setTimeout(captureLoop, delay);
		};

		captureLoop();
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
		} catch (e) {}
		ffmpegProcess = null;
	}

	if (browser) {
		try {
			await browser.close();
		} catch (e) {}
		browser = null;
	}
	
	console.log('Background streamer stopped.');
}

// Global cleanup event listener
process.on('exit', () => {
	if (ffmpegProcess) {
		try { ffmpegProcess.kill('SIGKILL'); } catch (e) {}
	}
});
