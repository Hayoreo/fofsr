
const App = {
	_sensorCanvasWidth: 96,
	_sensorCanvasHeight: 640,
	_sensorMax: 1024,
	_sensors: [],
	_profiles: [],
	start: () => {
		App._root = document.body;

		App._profilesSelect = document.createElement('select');
		App._profilesSelect.className = 'profile-select';
		App._profilesSelect.onchange = event => {
			let value = event.target.value;

			if (!value) return;
			
			event.target.value = null;

			App._socket.send(JSON.stringify({
				setActiveProfile: value,
			}));
		};
		App._root.appendChild(App._profilesSelect);

		App._secondaryProfilesSelect = document.createElement('select');
		App._secondaryProfilesSelect.className = 'profile-select';
		App._secondaryProfilesSelect.style.display = 'none';
		App._secondaryProfilesSelect.onchange = event => {
			let value = event.target.value;

			if (value === '_') value = null;

			event.target.value = null;

			App._socket.send(JSON.stringify({
				setSecondaryProfile: value,
			}));
		};
		App._root.appendChild(App._secondaryProfilesSelect);

		App._sensorsRoot = document.createElement('div');
		App._sensorsRoot.className = 'sensors-root';
		App._root.appendChild(App._sensorsRoot);
		
		App._connect();
	},
	_connect: () => {
		App._socket = new WebSocket(`ws://${location.hostname}:8069`);

		App._socket.addEventListener('message', App._handleWebsocketMessage);

		App._socket.addEventListener('close', event => {
			console.log('WebSocket disconnected. Reconnecting.');
			setTimeout(App._connect, 100);
		});

		App._socket.addEventListener('open', event => {
			console.log('WebSocket connection open.');
		});
	},
	_handleWebsocketMessage: event => {
		let message = JSON.parse(event.data);
		
		if (message.sensors) {
			App._handleSensors(message.sensors);
		}

		if (message.values) {
			App._handleValues(message.values);
		}
		
		if (message.thresholds) {
			App._handleThresholds(message.thresholds);
		}

		if (message.profiles) {
			App._handleProfiles(message.profiles);
		}

		if (message.activeProfile) {
			App._handleActiveProfile(message.activeProfile);
		}
		
		if (message.secondaryProfile !== undefined) {
			App._handleSecondaryProfile(message.secondaryProfile);
		}

		for (let sensor of App._sensors) {
			if (sensor.dirty) {
				App._renderSensor(sensor);
				sensor.dirty = false;
			}
		}
	},
	_handleProfiles: profiles => {
		App._profiles = profiles;
		App._profilesSelect.innerHTML = '';
		for (let profile of profiles) {
			let option = document.createElement('option');
			option.value = profile.name;
			option.appendChild(document.createTextNode(profile.name));
			App._profilesSelect.appendChild(option);
		}
		App._updateSecondaryProfiles();
	},
	_hasCommonGroup: (p1, p2) => {
		for (let g1 of p1.groups) {
			for (let g2 of p2.groups) {
				if (g1 === g2) {
					return true;
				}
			}
		}
		return false;
	},
	_updateSecondaryProfiles: () => {
		let [activeProfile] = App._profiles.filter(p => p.name === App._profilesSelect.value);

		let secondaryProfileNames = [];
		if (activeProfile) {
			for (let otherProfile of App._profiles) {
				if (!App._hasCommonGroup(activeProfile, otherProfile)) {
					secondaryProfileNames.push(otherProfile.name);
				}
			}
		}

		App._secondaryProfilesSelect.innerHTML = '';
		if (secondaryProfileNames.length === 0) {
			App._secondaryProfilesSelect.style.display = 'none';
		} else {
			App._secondaryProfilesSelect.style.display = '';
			let noneOption = document.createElement('option');
			noneOption.value = '_';
			noneOption.appendChild(document.createTextNode('(none)'));
			App._secondaryProfilesSelect.appendChild(noneOption);
			for (let name of secondaryProfileNames) {
				let option = document.createElement('option');
				option.value = name;
				option.appendChild(document.createTextNode(name));
				App._secondaryProfilesSelect.appendChild(option);
			}
			App._secondaryProfilesSelect.value = '_';
		}
	},
	_handleActiveProfile: activeProfile => {
		App._profilesSelect.value = activeProfile;
		
		App._updateSecondaryProfiles();
	},
	_handleSecondaryProfile: secondaryProfile => {
		App._secondaryProfilesSelect.value = secondaryProfile ? secondaryProfile : '_';
	},
	_handleSensors: sensors => {
		App._sensors = [];
		App._sensorsRoot.innerHTML = '';

		let groups = [];

		for (let i = 0; i < sensors.length; i++) {
			// declare sensorId within for block so we can use it in callbacks.
			let sensorId = i;

			let sensor = sensors[sensorId];

			let div = document.createElement('div');
			div.className = 'sensor';
			div.style.width = App._sensorCanvasWidth + 'px';

			let buttons = document.createElement('div');
			buttons.className = 'sensor-buttons';

			let decrementButton = document.createElement('button');
			decrementButton.appendChild(document.createTextNode('-'));
			decrementButton.className = 'sensor-button';
			decrementButton.addEventListener('click', () => App._changeThreshold(sensorId, -1));

			let incrementButton = document.createElement('button');
			incrementButton.appendChild(document.createTextNode('+'));
			incrementButton.className = 'sensor-button';
			incrementButton.addEventListener('click', () => App._changeThreshold(sensorId, 1));

			buttons.appendChild(decrementButton);
			buttons.appendChild(incrementButton);

			let label = document.createElement('div');
			label.className = 'sensor-label';
			label.appendChild(document.createTextNode(sensor.label));

			let canvas = document.createElement('canvas');
			canvas.className = 'sensor-value';

			canvas.width = App._sensorCanvasWidth;
			canvas.height = App._sensorCanvasHeight;

			canvas.addEventListener('click', event => {
				let rect = event.target.getBoundingClientRect();
				let x = event.clientX - rect.left;
				let y = event.clientY - rect.top;

				let threshold = App._sensorMax - y * (App._sensorMax / App._sensorCanvasHeight);
				threshold = Math.round(threshold);
				App._setThreshold(sensorId, threshold);
			});

			div.appendChild(label);
			div.appendChild(canvas);
			div.appendChild(buttons);

			if (!groups[sensor.group]) {
				groups[sensor.group] = document.createElement('div');
				groups[sensor.group].className = 'sensors-group';
				App._sensorsRoot.appendChild(groups[sensor.group]);
			}

			groups[sensor.group].appendChild(div);

			let context = canvas.getContext('2d');
			context.textAlign = 'center';
			context.font = 'bold 20px monospace';
			App._sensors.push({
				context: context,
				element: div,
				threshold: 0,
				value: 0,
				dirty: true,
			});
		}
	},
	_handleValues: values => {
		for (let id in values) {
			let newValue = values[id];
			let sensor = App._sensors[id];
			if (newValue != sensor.value) {
				sensor.value = newValue;
				sensor.dirty = true;
			}
		}
	},
	_handleThresholds: thresholds => {
		for (let id in thresholds) {
			let newThreshold = thresholds[id];
			let sensor = App._sensors[id];
			if (newThreshold != sensor.threshold) {
				sensor.threshold = newThreshold;
				sensor.dirty = true;
			}
		}
	},
	_changeThreshold: (sensorId, delta) => {
		App._socket.send(JSON.stringify({
			changeThreshold: {
				id: sensorId,
				delta: delta,
			},
		}));
	},
	_setThreshold: (sensorId, threshold) => {
		App._socket.send(JSON.stringify({
			setThreshold: {
				id: sensorId,
				threshold: threshold,
			},
		}));
	},
	_renderSensor: sensor => {
		if (sensor.threshold < 0) {
			sensor.element.classList.add('hidden');
			return;
		}

		sensor.element.classList.remove('hidden');

		sensor.context.clearRect(0, 0, App._sensorCanvasWidth, App._sensorCanvasHeight);

		sensor.context.fillStyle = sensor.value >= sensor.threshold
			? '#22bb66'
			: '#4477ee';

		let height = App._valueToHeight(sensor.value);
		let y = App._sensorCanvasHeight - height;

		sensor.context.fillRect(0, y, App._sensorCanvasWidth, height);
		
		let thresholdY = App._sensorCanvasHeight - App._valueToHeight(sensor.threshold);
		
		sensor.context.fillStyle = '#00000080';
		sensor.context.fillRect(0, thresholdY, App._sensorCanvasWidth, 2);
		sensor.context.fillRect(0, y, App._sensorCanvasWidth, 2);

		sensor.context.fillStyle = '#000000';
		sensor.context.fillText(sensor.threshold, 0.75*App._sensorCanvasWidth, thresholdY-5);
		sensor.context.fillText(sensor.value, 0.25*App._sensorCanvasWidth, y-5);
	},
	_valueToHeight: value => value * (App._sensorCanvasHeight / App._sensorMax),
}

window.addEventListener('load', App.start);