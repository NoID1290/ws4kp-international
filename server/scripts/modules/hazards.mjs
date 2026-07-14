// Weather Alerts — Environment Canada (ECCC) CAP-CP + Alert Ready

import STATUS from './status.mjs';
import WeatherDisplay from './weatherdisplay.mjs';
import { registerDisplay } from './navigation.mjs';
import { getAlerts, getSeverityColor } from './utils/eccc-alerts.mjs';

const hazardLevels = {
	Extreme: 10,
	Severe: 5,
	Moderate: 3,
	Minor: 1,
};

const hazardModifiers = {
	Tornade: 3,
	Ouragan: 2,
	'Orage violent': 1,
	Tornado: 3,
	Hurricane: 2,
	'Severe Thunderstorm': 1,
};

class Hazards extends WeatherDisplay {
	constructor(navId, elemId, defaultActive) {
		// special height and width for scrolling
		super(navId, elemId, 'Hazards', defaultActive);
		this.showOnProgress = false;

		// 0 screens skips this during "play"
		this.timing.totalScreens = 0;
	}

	async getData(weatherParameters) {
		// super checks for enabled
		const superResult = super.getData(weatherParameters);

		const alert = this.checkbox.querySelector('.alert');
		alert.classList.remove('show');

		try {
			// Fetch alerts from ECCC GeoMet OGC API
			const alertData = await getAlerts(
				this.weatherParameters.latitude,
				this.weatherParameters.longitude,
			);

			const { alerts: unsortedAlerts, hasAlertReady } = alertData;

			// Store Alert Ready status for display
			this.hasAlertReady = hasAlertReady;

			// Filter out unknown severity and sort
			const filteredAlerts = unsortedAlerts.filter(
				(hazard) => hazard.severity.toLowerCase() !== 'unknown',
			);

			this.data = filteredAlerts;

			// show alert indicator
			if (this.data.length > 0) alert.classList.add('show');
		} catch (error) {
			console.error('ECCC: Get weather alerts failed');
			console.error(error);
			if (this.isEnabled) this.setStatus(STATUS.failed);
			// return undefined to other subscribers
			this.getDataCallback(undefined);
			return;
		}

		this.getDataCallback();

		if (!superResult) {
			this.setStatus(STATUS.loaded);
			return;
		}
		this.drawLongCanvas();
	}

	async drawLongCanvas() {
		// get the list element and populate
		const list = this.elem.querySelector('.hazard-lines');
		list.innerHTML = '';

		// Update Alert Ready banner
		const alertReadyBanner = this.elem.querySelector('.alert-ready-banner');
		if (alertReadyBanner) {
			if (this.hasAlertReady) {
				alertReadyBanner.classList.add('show');
			} else {
				alertReadyBanner.classList.remove('show');
			}
		}

		const lines = this.data.map((data) => {
			const fillValues = {};
			const severity = (data.severity || '').toLowerCase();
			const severityColor = getSeverityColor(severity);
			const severityLabel = data.severity.toUpperCase();

			// Build the alert text with severity badge
			const severityBadge = `<span class="severity-badge" style="background-color: ${severityColor};">${severityLabel}</span>`;
			const alertReadyTag = data.isAlertReady
				? '<span class="alert-ready-tag">⚠ ALERTE PRÊTE</span>'
				: '';

			fillValues['hazard-text'] = `${severityBadge} ${alertReadyTag}`
				+ `<br/><strong>${data.headline || data.event}</strong>`
				+ `<br/><br/>${(data.description || '').replace(/\n\n/g, '<br/><br/>').replace(/\n/g, ' ')}`;

			if (data.instruction) {
				fillValues['hazard-text'] += `<br/><br/><em>${data.instruction}</em>`;
			}

			if (data.area) {
				fillValues['hazard-text'] += `<br/><br/><small>Zone: ${data.area}</small>`;
			}

			return this.fillTemplate('hazard', fillValues);
		});

		list.append(...lines);

		// no alerts, skip this display by setting timing to zero
		if (lines.length === 0) {
			this.setStatus(STATUS.loaded);
			this.timing.totalScreens = 0;
			this.setStatus(STATUS.loaded);
			return;
		}

		// update timing
		// set up the timing
		this.timing.baseDelay = 20;
		// 24 hours = 6 pages
		const pages = Math.max(Math.ceil(list.scrollHeight / 400) - 3, 1);
		const timingStep = 400;
		this.timing.delay = [150 + timingStep];
		// add additional pages
		for (let i = 0; i < pages; i += 1) this.timing.delay.push(timingStep);
		// add the final 3 second delay
		this.timing.delay.push(250);
		this.calcNavTiming();
		this.setStatus(STATUS.loaded);
	}

	drawCanvas() {
		super.drawCanvas();
		this.finishDraw();
	}

	showCanvas() {
		// special to hourly to draw the remainder of the canvas
		this.drawCanvas();
		super.showCanvas();
	}

	// screen index change callback just runs the base count callback
	screenIndexChange() {
		this.baseCountChange(this.navBaseCount);
	}

	// base count change callback
	baseCountChange(count) {
		// calculate scroll offset and don't go past end
		let offsetY = Math.min(this.elem.querySelector('.hazard-lines').getBoundingClientRect().height - 390, (count - 150));

		// don't let offset go negative
		if (offsetY < 0) offsetY = 0;

		// copy the scrolled portion of the canvas
		this.elem.querySelector('.main').scrollTo(0, offsetY);
	}

	// make data available outside this class
	// promise allows for data to be requested before it is available
	async getCurrentData(stillWaiting) {
		if (stillWaiting) this.stillWaitingCallbacks.push(stillWaiting);
		return new Promise((resolve) => {
			if (this.data) resolve(this.data);
			// data not available, put it into the data callback queue
			this.getDataCallbacks.push(() => resolve(this.data));
		});
	}

	// after we roll through the hazards once, don't display again until the next refresh (10 minutes)
	screenIndexFromBaseCount() {
		const superValue = super.screenIndexFromBaseCount();
		// false is returned when we reach the end of the scroll
		if (superValue === false) {
			// set total screens to zero to take this out of the rotation
			this.timing.totalScreens = 0;
		}
		// return the value as expected
		return superValue;
	}
}

const calcSeverity = (severity, event) => {
	// base severity plus some modifiers for specific types of warnings
	const baseSeverity = hazardLevels[severity] ?? 0;
	const modifiedSeverity = hazardModifiers[event] ?? 0;
	return baseSeverity + modifiedSeverity;
};

// register display
registerDisplay(new Hazards(0, 'hazards', true));
