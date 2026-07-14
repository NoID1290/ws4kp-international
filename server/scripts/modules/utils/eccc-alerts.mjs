/**
 * Environment Canada (ECCC) Weather Alerts — CAP-CP via GeoMet OGC API
 *
 * Fetches active weather alerts from the Meteorological Service of Canada.
 * Data is free and open under the Government of Canada Open Government Licence.
 *
 * This module also covers Alert Ready (NAAD/NPAS) alerts since ECCC is the
 * authoritative weather alert issuer in Canada's National Public Alerting System.
 *
 * @see https://eccc-msc.github.io/open-data/msc-data/alerts/readme_alerts_en/
 * @see https://api.weather.gc.ca/
 */

import { json } from './fetch.mjs';

// ECCC GeoMet OGC API — weather alerts collection
const ECCC_ALERTS_BASE = 'https://api.weather.gc.ca/collections/weather-alerts/items';

// Quebec approximate bounding box (lon_min, lat_min, lon_max, lat_max)
const QUEBEC_BBOX = [-79.8, 44.9, -57.1, 62.6];

// Severity ranking for sorting (higher = more severe)
const SEVERITY_RANK = {
	extreme: 4,
	severe: 3,
	moderate: 2,
	minor: 1,
	unknown: 0,
};

// Urgency ranking for secondary sort
const URGENCY_RANK = {
	immediate: 4,
	expected: 3,
	future: 2,
	past: 1,
	unknown: 0,
};

// ECCC colour-coded alert system (since Nov 2025)
const SEVERITY_COLORS = {
	extreme: '#ff0000', // Red
	severe: '#ff0000',  // Red
	moderate: '#ff8c00', // Orange
	minor: '#ffd700',   // Yellow
	unknown: '#999999',
};

/**
 * Determines if an alert qualifies as "Alert Ready" level.
 */
const isAlertReady = (props) => {
	const alertType = (props.alert_type || '').toLowerCase();
	const riskColor = (props.risk_colour_en || '').toLowerCase();
	return alertType === 'warning' || riskColor === 'red';
};

const getSeverityValue = (props) => {
	const color = (props.risk_colour_en || '').toLowerCase();
	const type = (props.alert_type || '').toLowerCase();
	if (color === 'red' || type === 'warning') return 'extreme';
	if (color === 'orange' || type === 'watch') return 'moderate';
	if (color === 'yellow' || type === 'advisory') return 'minor';
	return 'minor';
};

/**
 * Get the colour for a given severity level.
 */
const getSeverityColor = (severity) => SEVERITY_COLORS[(severity || '').toLowerCase()] || SEVERITY_COLORS.unknown;

/**
 * Fetches active weather alerts from ECCC for a given lat/lon.
 * Uses a bounding box around the point to find relevant alerts.
 *
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {number} [radius=1.0] - Approximate radius in degrees for the bounding box
 * @returns {Promise<object>} - Object with sorted alerts array and metadata
 */
const getAlerts = async (lat, lon, radius = 1.0) => {
	try {
		// Build bbox around the point (lon_min, lat_min, lon_max, lat_max)
		const bbox = [
			Math.max(lon - radius, QUEBEC_BBOX[0]),
			Math.max(lat - radius, QUEBEC_BBOX[1]),
			Math.min(lon + radius, QUEBEC_BBOX[2]),
			Math.min(lat + radius, QUEBEC_BBOX[3]),
		].join(',');

		const url = `${ECCC_ALERTS_BASE}?f=json&lang=fr&limit=50&bbox=${bbox}`;
		console.log('ECCC Alerts: Fetching from', url);

		const response = await json(url, { retryCount: 2 });

		if (!response || !response.features) {
			console.log('ECCC Alerts: No features in response');
			return { alerts: [], hasAlertReady: false };
		}

		// Parse and normalize alerts from ECCC GeoJSON properties
		const alerts = response.features
			.map((feature) => {
				const props = feature.properties || {};
				const severity = getSeverityValue(props);
				return {
					id: feature.id || props.id || '',
					headline: props.alert_name_fr || props.alert_name_en || '',
					description: props.alert_text_fr || props.alert_text_en || '',
					event: props.alert_name_fr || props.alert_name_en || '',
					severity: severity,
					urgency: props.alert_type === 'warning' ? 'immediate' : 'expected',
					certainty: props.confidence_fr || 'Observed',
					effective: props.publication_datetime || '',
					expires: props.expiration_datetime || '',
					sent: props.publication_datetime || '',
					sender: 'Environnement Canada',
					status: props.status_fr || '',
					msgType: props.alert_type || '',
					references: '',
					area: props.feature_name_fr || props.feature_name_en || '',
					instruction: '',
					// Computed fields
					severityRank: SEVERITY_RANK[severity] || 0,
					urgencyRank: props.alert_type === 'warning' ? 4 : 2,
					severityColor: getSeverityColor(severity),
					isAlertReady: isAlertReady(props),
					url: `https://meteo.gc.ca/warnings/report_f.html?id=${props.alert_code || ''}`,
				};
			})
			// Filter out expired alerts
			.filter((alert) => {
				if (!alert.expires) return true;
				return new Date(alert.expires) > new Date();
			})
			// Sort by severity (desc), then urgency (desc), then sent (desc)
			.sort((a, b) => {
				if (b.severityRank !== a.severityRank) return b.severityRank - a.severityRank;
				if (b.urgencyRank !== a.urgencyRank) return b.urgencyRank - a.urgencyRank;
				// Most recent first
				return new Date(b.sent || 0) - new Date(a.sent || 0);
			});

		// Deduplicate by headline (ECCC sometimes sends updates)
		const seen = new Set();
		const deduplicated = alerts.filter((alert) => {
			const key = alert.headline || alert.event;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});

		const hasAlertReady = deduplicated.some((alert) => alert.isAlertReady);

		console.log(`ECCC Alerts: Found ${deduplicated.length} active alerts (Alert Ready: ${hasAlertReady})`);

		return {
			alerts: deduplicated,
			hasAlertReady,
		};
	} catch (error) {
		console.error('ECCC Alerts: Failed to fetch alerts', error);
		return { alerts: [], hasAlertReady: false };
	}
};

export {
	getAlerts,
	getSeverityColor,
	isAlertReady,
	SEVERITY_COLORS,
};
