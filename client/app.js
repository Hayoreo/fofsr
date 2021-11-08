
const App = {
	start: () => {
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
		console.log('GOT MESSAGE:', event);
	},
}

window.addEventListener('load', App.start);