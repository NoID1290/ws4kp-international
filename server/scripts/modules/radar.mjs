/* eslint-disable no-param-reassign */
/* eslint-disable no-plusplus */
/* eslint-disable no-underscore-dangle */
import STATUS from './status.mjs';
import WeatherDisplay from './weatherdisplay.mjs';
import { registerDisplay } from './navigation.mjs';
import { DateTime } from '../vendor/auto/luxon.mjs';

import { getConditionText } from './utils/weather.mjs';
import { getWeatherIconFromIconLink } from './icons.mjs';
import { haversineDistance } from './utils/calc.mjs';

import ConversionHelpers from './utils/conversionHelpers.mjs';
import ExperimentalFeatures from './utils/experimental.mjs';
import RadarBoundsCities from './utils/radar-bounds-cities.mjs';
import RadarUtils from './utils/radar-utils.mjs';
import { GEOMET_WMS_URL, RADAR_LAYER, getRadarTimesteps } from './utils/eccc-radar.mjs';

class Radar extends WeatherDisplay {
	// ECCC GeoMet WMS — replaces RainViewer
	static radarSource = GEOMET_WMS_URL;

	static tileSource = 'https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}';

	static defaultCityDistance = 40; 				// 40 km

	static additionalLocationBufferDistance = 10; 	// 10 km

	static radarIterationCount = 3;

	constructor(navId, elemId) {
		super(navId, elemId, 'Local Radar', true);

		this.okToDrawCurrentConditions = false;
		this.okToDrawCurrentDateTime = false;

		this.radarLayers = [];
		this.mapFrames = [];
		this.animationPosition = 0;
		this.lastPastFramePosition = -1;
		this.loadingTilesCount = 0;
		this.loadedTilesCount = 0;
		this.radarData = {};
		this.locationMarker = null;

		// Set max images - this will be updated when we get actual data
		this.dopplerRadarImageMax = 12;

		// Update timing for animation
		this.timing.baseDelay = 500; // 500ms per frame
		this.timing.delay = 1; // Each frame shows for 1 * baseDelay
		this.timing.totalScreens = 1; // Will be updated when data loads
	}

	// this is for the nearby cities _only_
	static getWeatherForCityFromNearestHour(cityOpenMeteoData) {
		if (!cityOpenMeteoData || !cityOpenMeteoData.time) return null;

		const now = new Date();
		const currentHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());

		let nearestIndex = 0;
		let smallestDiff = Infinity;

		for (let i = 0; i < cityOpenMeteoData.time.length; i++) {
			const dataTime = new Date(cityOpenMeteoData.time[i]);
			const diff = Math.abs(dataTime - currentHour);
			if (diff < smallestDiff) {
				smallestDiff = diff;
				nearestIndex = i;
			}
		}

		return {
			time: cityOpenMeteoData.time[nearestIndex],
			temperature: cityOpenMeteoData.temperature_2m[nearestIndex],
			weatherCode: cityOpenMeteoData.weather_code[nearestIndex],
		};
	}

	static createWeatherIconHTML(weatherCode, temperature, cityName, timeZone) {
		const text = getConditionText(parseInt(weatherCode, 10));
		const weatherIcon = getWeatherIconFromIconLink(text, timeZone, true);

		return `
		<div style="margin:0; padding: 0; display: flex; flex-direction: column;">
			<div class="row-1" style="display: flex; width: 100%;">
				<div style="
					text-shadow: 3px 3px 0 #000, -1.5px -1.5px 0 #000, 0 -1.5px 0 #000, 1.5px -1.5px 0 #000, 1.5px 0 0 #000, 1.5px 1.5px 0 #000, 0 1.5px 0 #000, -1.5px 1.5px 0 #000, -1.5px 0 0 #000;
					font-family: 'Star4000';
					font-size: 18pt;"
				>${cityName}</div>
			</div>
			<div class="temperature-icon" style="display: flex; align-items: center; margin-top: -14px;">
				<div style="
					padding-right: 6px;
					font-family: 'Star4000';
					text-shadow: 3px 3px 0 #000, -1.5px -1.5px 0 #000, 0 -1.5px 0 #000, 1.5px -1.5px 0 #000, 1.5px 0 0 #000, 1.5px 1.5px 0 #000, 0 1.5px 0 #000, -1.5px 1.5px 0 #000, -1.5px 0 0 #000;
					font-size: 36px;
					color: #ff0;">${Math.round(temperature)}</div>
				<img src="${weatherIcon}" alt="Weather" style="width: auto; height: 40px;" />
			</div>
		</div>
	`;
	}

	addLocationMarker(latitude, longitude, cityName, weatherData = null) {
	// Remove existing marker if it exists
		if (this.locationMarker && window._leafletMap) {
			window._leafletMap.removeLayer(this.locationMarker);
		}

		if (!window._leafletMap) {
			console.warn('Map not initialized');
			return;
		}

		let markerContent;

		if (weatherData && weatherData.icon && weatherData.temperature !== undefined) {
			markerContent = Radar.createWeatherIconHTML(
				weatherData.icon,
				weatherData.temperature,
				cityName,
				this.weatherParameters.timeZone,
			);
		} else {
			// Simple city name marker
			markerContent = `
				<div class="city-marker" style="
					background: rgba(0, 0, 0, 0.8);
					color: white;
					border-radius: 6px;
					padding: 6px 10px;
					font-family: Arial, sans-serif;
					font-size: 14px;
					font-weight: bold;
					text-align: center;
					box-shadow: 0 2px 8px rgba(0,0,0,0.3);
					border: 2px solid white;
					white-space: nowrap;
				">
					${cityName}
				</div>
			`;
		}

		const customIcon = window.L.divIcon({
			html: markerContent,
			className: 'custom-weather-marker',
			iconSize: [140, 120],
			iconAnchor: [60, 60], // Center the marker
			popupAnchor: [0, -60],
		});

		this.locationMarker = window.L.marker([latitude, longitude], {
			icon: customIcon,
			zIndexOffset: 1000, // Ensure it appears above other layers
		}).addTo(window._leafletMap);

		return this.locationMarker;
	}

	updateLocationMarker(weatherData) {
		if (!this.locationMarker || !weatherData) return;

		const markerContent = Radar.createWeatherIconHTML(
			weatherData.icon,
			ConversionHelpers.convertTemperatureUnits(weatherData.temperature),
			weatherData.cityName || 'Current Location',
			this.weatherParameters.timeZone,
		);

		const customIcon = window.L.divIcon({
			html: markerContent,
			className: 'custom-weather-marker',
			iconSize: [140, 120],
			iconAnchor: [60, 60], // Center the marker
			popupAnchor: [0, -60],
		});

		this.locationMarker.setIcon(customIcon);
	}

	isTilesLoading() {
		return this.loadingTilesCount > this.loadedTilesCount;
	}

	static removeLayer(layer) {
		if (!layer) {
			console.warn('Tried to remove a layer, but layer is undefined or null');
			return;
		}

		if (!window._leafletMap) {
			console.warn('Leaflet map is not initialized');
			return;
		}

		if (!window._leafletMap.hasLayer(layer)) {
			console.warn('Layer not found on the map:', layer);
			return;
		}

		console.log('Removing layer:', layer);
		window._leafletMap.removeLayer(layer);
	}

	addLayer(frame) {
		if (!frame) return null;

		// Check if layer already exists for this timestamp
		const existingLayer = this.radarLayers.find((layer) => layer.ecccTimestamp === frame.timestamp);

		if (existingLayer) {
			return existingLayer;
		}

		// Create ECCC WMS tile layer for this timestep
		const source = window.L.tileLayer.wms(GEOMET_WMS_URL, {
			layers: RADAR_LAYER,
			format: 'image/png',
			transparent: true,
			version: '1.3.0',
			crs: window.L.CRS.EPSG3857,
			time: frame.timestamp,
			opacity: 0, // Start invisible
		});

		// Store the timestamp on the layer for identification
		source.ecccTimestamp = frame.timestamp;

		// Add event handlers for tile loading
		source.on('loading', () => {
			this.loadingTilesCount++;
		});

		source.on('load', () => {
			this.loadedTilesCount++;
		});

		source.on('tileerror', (e) => {
			console.warn('ECCC Radar tile failed to load:', e);
			this.loadedTilesCount++; // Count failed tiles as "loaded" to prevent infinite waiting
		});

		this.radarLayers.push(source);
		source.addTo(window._leafletMap);

		return source;
	}

	changeRadarPosition(position, preloadOnly = false, force = false) {
	// Wrap position to valid range
		while (position >= this.mapFrames.length) {
			position -= this.mapFrames.length;
		}
		while (position < 0) {
			position += this.mapFrames.length;
		}

		if (this.mapFrames.length === 0) return;

		const nextFrame = this.mapFrames[position];

		// Find or create the layer for the next frame
		let nextLayer = this.radarLayers.find((layer) => layer.ecccTimestamp === nextFrame.timestamp);

		if (!nextLayer) {
			nextLayer = this.addLayer(nextFrame);
		}

		// Quit if this call is for preloading only
		if (preloadOnly) {
			return;
		}

		// Don't wait for tiles if forced, or if we're not currently loading
		if (!force && this.isTilesLoading()) {
		// Set a timeout to try again
			setTimeout(() => {
				this.changeRadarPosition(position, false, true);
			}, 100);
			return;
		}

		// Hide all layers first
		this.radarLayers.forEach((layer) => {
			if (layer && layer.setOpacity) {
				layer.setOpacity(0);
			}
		});

		// Update position
		this.animationPosition = position;

		// Show the current frame
		if (nextLayer && nextLayer.setOpacity) {
			nextLayer.setOpacity(0.8);
		}

		// Update timestamp display
		this.updateTimestamp(nextFrame);
	}

	updateTimestamp(frame) {
		const timeElem = this.elem.querySelector('.time');
		if (timeElem && frame.timestamp) {
			const frameTime = DateTime.fromISO(frame.timestamp).setZone(this.weatherParameters.timeZone);
			const frameUnix = new Date(frame.timestamp).getTime() / 1000;
			const pastOrForecast = frameUnix > Date.now() / 1000 ? 'PRÉVISION' : 'PASSÉ';
			const timeString = frameTime.toLocaleString(DateTime.TIME_SIMPLE);
			timeElem.innerHTML = `${pastOrForecast}: ${timeString}`;
		}
	}

	showFrame(nextPosition, force = false) {
		if (this.mapFrames.length === 0) return;

		const preloadingDirection = nextPosition - this.animationPosition > 0 ? 1 : -1;

		this.changeRadarPosition(nextPosition, false, force);

		// Preload next frame
		const preloadPosition = (nextPosition + preloadingDirection + this.mapFrames.length) % this.mapFrames.length;
		this.changeRadarPosition(preloadPosition, true);
	}

	static async getRadarData() {
		try {
			// Get available timesteps from ECCC GeoMet WMS
			const timesteps = await getRadarTimesteps();
			console.log(`ECCC Radar: Got ${timesteps.length} timesteps`);
			return { timesteps };
		} catch (error) {
			console.error('Failed to fetch ECCC radar data:', error);
			throw error;
		}
	}

	async initializeRadar(api) {
		// Clear existing layers
		if (window._leafletMap && Array.isArray(this.radarLayers)) {
			this.radarLayers.forEach((layer) => {
				if (window._leafletMap.hasLayer(layer)) {
					window._leafletMap.removeLayer(layer);
				}
			});
		}

		// Reset state
		this.mapFrames = [];
		this.radarLayers = [];
		this.animationPosition = 0;
		this.loadingTilesCount = 0;
		this.loadedTilesCount = 0;

		if (!api || !api.timesteps || !api.timesteps.length) return;

		// Build frames from ECCC timesteps
		// Repeat past frames for animation effect (like original RainViewer logic)
		const pastFrames = api.timesteps.map((timestamp) => ({ timestamp }));
		this.mapFrames = Array(Radar.radarIterationCount).fill(pastFrames).flat();
		this.lastPastFramePosition = pastFrames.length - 1;

		// Update timing based on actual frame count
		this.timing.totalScreens = this.mapFrames.length;
		this.calcNavTiming();

		// Show initial frame (last past frame)
		if (this.mapFrames.length > 0) {
			this.showFrame(this.lastPastFramePosition, true);
		}

		if (ExperimentalFeatures.getExperimentalFlag()) {
			const bounds = window._leafletMap.getBounds();
			const sw = bounds.getSouthWest();
			const ne = bounds.getNorthEast();

			const cities = await RadarBoundsCities.getBoundingBoxCities(sw.lng, sw.lat, ne.lng, ne.lat).catch((error) => {
				console.error('Error fetching bounding box cities:', error);
				return [];
			});

			// Do this so the map isn't cluttered around origin location
			const filteredCities = cities.filter((city) => {
				const distance = haversineDistance(this.weatherParameters.latitude, this.weatherParameters.longitude, parseFloat(city.lat), parseFloat(city.lon));
				return distance >= Radar.defaultCityDistance + Radar.additionalLocationBufferDistance;
			});

			filteredCities.forEach(async (cityData) => {
				if (
					cityData.city !== this.weatherParameters.city
					&& !filteredCities.some(
						(other) => other !== cityData
							&& haversineDistance(
								parseFloat(cityData.lat),
								parseFloat(cityData.lon),
								parseFloat(other.lat),
								parseFloat(other.lon),
							) < Radar.defaultCityDistance,
					)
				) {
					const lat = parseFloat(cityData.lat);
					const lon = parseFloat(cityData.lon);
					const name = cityData.city;

					const weatherData = await RadarBoundsCities.getWeatherForCity(lat, lon);
					const cityWeather = Radar.getWeatherForCityFromNearestHour(weatherData);

					const location = Radar.createWeatherIconHTML(
						cityWeather.weatherCode,
						cityWeather.temperature,
						name,
						this.weatherParameters.timeZone,
					);

					let latlng = window.L.latLng(lat, lon);
					const overlapArea = RadarUtils.getMaxOverlapWithMarkers(latlng);

					if (overlapArea > 0.3) {
						latlng = RadarUtils.jitterAwayFromOverlaps(latlng);
					}

					const label = window.L.marker(latlng, {
						icon: window.L.divIcon({
							className: 'custom-weather-marker',
							html: location,
							iconSize: [140, 120],
							iconAnchor: [50, 10],
						}),
						interactive: false,
					});

					label.addTo(window._leafletMap);
				}
			});
		}
	}

	refreshCurrentFrame() {
		if (this.mapFrames.length > 0) {
			this.showFrame(this.animationPosition, true);
		}
	}

	async getData(_weatherParameters) {
		const superResult = super.getData(_weatherParameters);
		if (!superResult) return;

		const weatherParameters = _weatherParameters ?? this.weatherParameters;

		const leafletDefaultZoom = 7;
		const leafletInitializationOptions = {
			zoomControl: false,
			dragging: false,
			touchZoom: false,
			scrollWheelZoom: false,
			doubleClickZoom: false,
			boxZoom: false,
			keyboard: false,
			tap: false,
			attributionControl: false,
		};

		try {
			const mapContainer = document.getElementById('map');

			// Initialize Leaflet map if not already done
			if (!mapContainer._leaflet_id) {
				window._leafletMap = window.L.map(mapContainer, leafletInitializationOptions)
					.setView([weatherParameters.latitude, weatherParameters.longitude], leafletDefaultZoom);

				window.L.tileLayer(Radar.tileSource, {
					attribution: 'Tiles &copy; Esri &mdash; Sources: GEBCO, NOAA, CHS, OSU, UNH, CSUMB, National Geographic, DeLorme, NAVTEQ, and Esri',
				}).addTo(window._leafletMap);
			} else {
				window._leafletMap.setView([weatherParameters.latitude, weatherParameters.longitude], leafletDefaultZoom);
			}

			// Get radar data from ECCC GeoMet WMS
			this.radarData = await Radar.getRadarData();
			await this.initializeRadar(this.radarData);

			const todayKey = DateTime.now().setZone(weatherParameters.timeZone).toFormat('yyyy-MM-dd');

			const currentWeatherData = {
				icon: weatherParameters.forecast[todayKey].weather_code,
				temperature: weatherParameters.Temperature,
				city: weatherParameters.city,
			};

			this.addLocationMarker(
				weatherParameters.latitude,
				weatherParameters.longitude,
				weatherParameters.city,
				currentWeatherData,
			);

			this.setStatus(STATUS.loaded);
		} catch (error) {
			console.error('Failed to initialize radar:', error);
			this.setStatus(STATUS.failed);
		}
	}

	// Handle screen index changes from base class navigation
	screenIndexChange(screenIndex) {
		if (this.mapFrames.length > 0) {
			this.showFrame(screenIndex);
		}
	}

	async drawCanvas() {
		super.drawCanvas();

		// Update the display if we have frames
		if (this.mapFrames.length > 0) {
			this.showFrame(this.screenIndex);
		}

		this.finishDraw();
	}
}

registerDisplay(new Radar(10, 'radar'));
