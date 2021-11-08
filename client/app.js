
const App = {
	_sensorCanvasWidth: 96,
	_sensorCanvasHeight: 640,
	_sensorMax: 1024,
	_triggeredColor: '#22bb66',
	_idleColor: '#4477ee',
	_sensors: [],
	start: () => {
		App._root = document.body;
		
		const socket = new WebSocket('ws://localhost:8069');

		socket.addEventListener('message', App._handleWebsocketMessage);

		socket.addEventListener('error', event => {
			console.log('TODO: Handle error', event);
		});

		socket.addEventListener('close', event => {
			console.log('TODO: handle close', event);
		});

		socket.addEventListener('open', event => {
			console.log('WebSocket connection open.');
		});
	},
	_handleWebsocketMessage: event => {
		message = JSON.parse(event.data);
		
		if (message.sensors) {
			App._handleSensors(message.sensors);
		}

		if (message.values) {
			App._handleValues(message.values);
		}

		for (let sensor of App._sensors) {
			if (sensor.dirty) {
				App._renderSensor(sensor);
				sensor.dirty = false;
			}
		}
	},
	_handleSensors: sensors => {
		App._sensors = [];
		App._root.innerHTML = '';

		for (let sensor of sensors) {
			let div = document.createElement('div');
			div.className = 'sensor';
			div.style.width = App._sensorCanvasWidth + 'px';

			let buttons = document.createElement('div');
			buttons.className = 'sensor-buttons';

			let decrementButton = document.createElement('button');
			decrementButton.appendChild(document.createTextNode('-'));
			decrementButton.className = 'sensor-button';

			let incrementButton = document.createElement('button');
			incrementButton.appendChild(document.createTextNode('+'));
			incrementButton.className = 'sensor-button';

			buttons.appendChild(decrementButton);
			buttons.appendChild(incrementButton);

			let label = document.createElement('div');
			label.className = 'sensor-label';
			label.appendChild(document.createTextNode(sensor.label));

			let canvas = document.createElement('canvas');
			canvas.className = 'sensor-value';

			canvas.width = App._sensorCanvasWidth;
			canvas.height = App._sensorCanvasHeight;

			div.appendChild(label);
			div.appendChild(canvas);
			div.appendChild(buttons);
			App._root.appendChild(div);
			App._sensors.push({
				context: canvas.getContext('2d'),
				threshold: 100,
				value: 0,
				dirty: true,
			});
		}
	},
	_handleValues: values => {
		for (let id in values) {
			let newValue = message.values[id];
			let sensor = App._sensors[id];
			if (newValue != sensor.value) {
				sensor.value = newValue;
				sensor.dirty = true;
			}
		}
	},
	_renderSensor: sensor => {
		sensor.context.clearRect(0, 0, App._sensorCanvasWidth, App._sensorCanvasHeight);

		sensor.context.fillStyle = sensor.value >= sensor.threshold
			? App._triggeredColor
			: App._idleColor;

		let height = sensor.value * (App._sensorCanvasHeight / App._sensorMax);
		let y = App._sensorCanvasHeight - height;

		sensor.context.fillRect(0, y, App._sensorCanvasWidth, height);
	},
}

window.addEventListener('load', App.start);