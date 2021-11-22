
const App = {
	_sensorCanvasWidth: 96,
	_sensorCanvasHeight: 640,
	_sensorMax: 1024,
	_triggeredColor: '#22bb66',
	_idleColor: '#4477ee',
	_sensors: [],
	start: () => {
    
    // TODO : REMOVE BELOW
    let bgCanvas = document.createElement('canvas');
    bgCanvas.width = 640;
    bgCanvas.height = 160;
    
    //document.body.appendChild(bgCanvas);
    let ctx = bgCanvas.getContext('2d');

    let chunkCount = 5;
    let rectSize = 1 << (chunkCount-1);
    for (let i = 0; i < chunkCount; i++) {
      let chunkStart = Math.floor(bgCanvas.width * i / chunkCount);
      let chunkEnd = chunkStart + Math.floor(bgCanvas.width / chunkCount);
      
      for (let x = chunkStart; x < chunkEnd; x += rectSize) {
        for (let y = 0; y < bgCanvas.height; y += rectSize) {
          let r = 0x11 + Math.floor(Math.random() * 8);
          let g = 0x13 + Math.floor(Math.random() * 8);
          let b = 0x1C + Math.floor(Math.random() * 12);

          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fillRect(x, y, rectSize, rectSize);
        }
      }
      
      rectSize /= 2;
    }
    // TODO : REMOVE ABOVE
    
    
    
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

    App._sensorsRoot = document.createElement('div');
    App._root.appendChild(App._sensorsRoot);
    
		App._connect();
	},
	_connect: () => {
		App._socket = new WebSocket('ws://localhost:8069');

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

		for (let sensor of App._sensors) {
			if (sensor.dirty) {
				App._renderSensor(sensor);
				sensor.dirty = false;
			}
		}
	},
  _handleProfiles: profiles => {
    App._profilesSelect.innerHTML = '';
    for (let profile of profiles) {
      let option = document.createElement('option');
      option.value = profile;
      option.appendChild(document.createTextNode(profile));
      App._profilesSelect.appendChild(option);
    }
  },
  _handleActiveProfile: activeProfile => {
    App._profilesSelect.value = activeProfile;
  },
	_handleSensors: sensors => {
		App._sensors = [];
		App._sensorsRoot.innerHTML = '';

		console.log(sensors);

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
				console.log('click!');
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
			App._sensorsRoot.appendChild(div);
			App._sensors.push({
				context: canvas.getContext('2d'),
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
			? App._triggeredColor
			: App._idleColor;

		let height = App._valueToHeight(sensor.value);
		let y = App._sensorCanvasHeight - height;

		sensor.context.fillRect(0, y, App._sensorCanvasWidth, height);
		
		let thresholdY = App._sensorCanvasHeight - App._valueToHeight(sensor.threshold);
		
		sensor.context.fillStyle = '#000000';
		sensor.context.fillRect(0, thresholdY-2, App._sensorCanvasWidth, 4);
	},
	_valueToHeight: value => value * (App._sensorCanvasHeight / App._sensorMax),
}

window.addEventListener('load', App.start);