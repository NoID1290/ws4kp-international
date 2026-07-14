/**
 * Environment Canada (ECCC) Radar — MSC GeoMet WMS Integration
 *
 * Provides radar imagery from ECCC's GeoMet WMS service for use with Leaflet.
 * Uses the RADAR_1KM_RDBR layer (1km radar composite — rain, snow, mixed precipitation).
 *
 * Data is free and open under the Government of Canada Open Government Licence.
 *
 * @see https://eccc-msc.github.io/open-data/msc-data/obs_radar/readme_radar_en/
 * @see https://geo.weather.gc.ca/geomet
 */

// ECCC GeoMet WMS base URL
const GEOMET_WMS_URL = 'https://geo.weather.gc.ca/geomet';

// Radar layer — 1km composite (rain, snow, mixed)
const RADAR_LAYER = 'Radar_1km_SfcPrecipType';

// Number of past timesteps to request for animation
const PAST_TIMESTEPS = 12;

// Time between frames in minutes (ECCC radar updates roughly every 6 min)
const FRAME_INTERVAL_MINUTES = 6;

/**
 * Fetches available radar timesteps from ECCC GeoMet WMS GetCapabilities.
 * Falls back to generating estimated timesteps if GetCapabilities parsing fails.
 *
 * @returns {Promise<string[]>} - Array of ISO 8601 timestamps for available radar frames
 */
const getRadarTimesteps = async () => {
	try {
		// Try to get timesteps from the WMS GetCapabilities
		const capUrl = `${GEOMET_WMS_URL}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities&LAYERS=${RADAR_LAYER}`;

		const response = await fetch(capUrl);
		if (!response.ok) {
			throw new Error(`GetCapabilities failed: ${response.status}`);
		}

		const xmlText = await response.text();

		// Parse the time dimension from the XML
		// The format is typically: start/end/interval (ISO 8601)
		const dimensionMatch = xmlText.match(/<Dimension[^>]*name="time"[^>]*>([\s\S]*?)<\/Dimension>/i);

		if (dimensionMatch && dimensionMatch[1]) {
			const timeContent = dimensionMatch[1].trim();

			// ECCC can return either a list of timestamps or a range (start/end/interval)
			if (timeContent.includes('/')) {
				// Range format: start/end/PT10M
				const parts = timeContent.split('/');
				if (parts.length >= 2) {
					return generateTimestepsFromRange(parts[0], parts[1], parts[2]);
				}
			} else {
				// Comma-separated list of timestamps
				const timestamps = timeContent.split(',').map((t) => t.trim()).filter(Boolean);
				if (timestamps.length > 0) {
					// Return the last PAST_TIMESTEPS timestamps
					return timestamps.slice(-PAST_TIMESTEPS);
				}
			}
		}

		// Fallback: generate timestamps manually
		console.warn('ECCC Radar: Could not parse time dimension from GetCapabilities, using fallback');
		return generateFallbackTimesteps();
	} catch (error) {
		console.error('ECCC Radar: Error fetching GetCapabilities', error);
		return generateFallbackTimesteps();
	}
};

/**
 * Generates timesteps from a range format (start/end/interval).
 */
const generateTimestepsFromRange = (startStr, endStr, intervalStr) => {
	const start = new Date(startStr);
	const end = new Date(endStr);

	// Parse interval (PT10M format)
	let intervalMs = FRAME_INTERVAL_MINUTES * 60 * 1000;
	if (intervalStr) {
		const minuteMatch = intervalStr.match(/PT(\d+)M/);
		if (minuteMatch) {
			intervalMs = parseInt(minuteMatch[1], 10) * 60 * 1000;
		}
	}

	const timestamps = [];
	let current = new Date(end.getTime());

	// Go backwards from end to get the last N timesteps
	for (let i = 0; i < PAST_TIMESTEPS && current >= start; i += 1) {
		timestamps.unshift(current.toISOString().split('.')[0] + 'Z');
		current = new Date(current.getTime() - intervalMs);
	}

	return timestamps;
};

/**
 * Generates fallback timesteps based on current time.
 * Goes back PAST_TIMESTEPS * FRAME_INTERVAL_MINUTES from now.
 */
const generateFallbackTimesteps = () => {
	const now = new Date();
	// Round down to nearest FRAME_INTERVAL_MINUTES
	const roundedMinutes = Math.floor(now.getMinutes() / FRAME_INTERVAL_MINUTES) * FRAME_INTERVAL_MINUTES;
	now.setMinutes(roundedMinutes, 0, 0);

	const timestamps = [];
	for (let i = PAST_TIMESTEPS - 1; i >= 0; i -= 1) {
		const ts = new Date(now.getTime() - (i * FRAME_INTERVAL_MINUTES * 60 * 1000));
		timestamps.push(ts.toISOString().split('.')[0] + 'Z');
	}

	return timestamps;
};

/**
 * Creates a Leaflet WMS TileLayer for ECCC radar at a specific time.
 *
 * @param {string} timestamp - ISO 8601 timestamp for the radar frame
 * @param {object} [options] - Additional options
 * @returns {object} - Leaflet WMS TileLayer configuration
 */
const createRadarLayerConfig = (timestamp, options = {}) => ({
	url: GEOMET_WMS_URL,
	wmsParams: {
		layers: RADAR_LAYER,
		format: 'image/png',
		transparent: true,
		version: '1.3.0',
		crs: 'EPSG:3857',
		time: timestamp,
		...options,
	},
});

export {
	GEOMET_WMS_URL,
	RADAR_LAYER,
	PAST_TIMESTEPS,
	getRadarTimesteps,
	createRadarLayerConfig,
};
