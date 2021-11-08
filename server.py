import asyncio
import websockets
import json
from collections import namedtuple

import logging
from serial_connection import SerialConnection

SensorConfig = namedtuple('SensorConfig', ['port', 'pin', 'label'])

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

main_thread_loop = asyncio.get_event_loop()

active_websockets = set()
serial_connections = None


async def handle_serial_message(port_name, msg):
	print('Received serial message:', msg)


async def handle_websocket_message(websocket, msg):
	try:
		msg_data = json.loads(msg)
	except Exception:
		log.exception(f'Received invalid JSON {msg}')
		return

	try:
		msg_type = msg_data.get('type')
		if msg_type == 'list_ports':
			await send_ports(websocket)
		elif msg_type == 'set_ports':
			await set_ports(msg['ports'])
		else:
			log.warning(f'Received unknown message type {msg_type}')
	except Exception:
		log.exception(f'Failed to handle message {msg}')

async def handle_websocket_connection(websocket, path):
	active_websockets.add(websocket)
	try:
		while True:
			msg = await websocket.recv()
			await handle_websocket_message(websocket, msg)
	finally:
		active_websockets.discard(websocket)

def load_sensor_configs():
	sensor_configs = []
	with open('sensors.txt', 'r') as sensors_file:
		for line_index, line in enumerate(sensors_file.readlines()):
			try:
				line = line.strip()
				if not line or line.startswith('#'):
					continue
				parts = line.split(',')
				port, pin, label = (part.strip() for part in parts)
				pin = int(pin)
				sensor_configs.append(SensorConfig(port=port, pin=pin, label=label))
			except Exception as e:
				raise RuntimeError(f'Failed to parse sensors.txt line {line_num}') from e

	return sensor_configs



if __name__ == '__main__':
	sensor_configs = load_sensor_configs()

	ports = set(config.port for config in sensor_configs)

	serial_connections = {
		port: SerialConnection(
			port,
			lambda message: main_thread_loop.call_soon_threadsafe(
				handle_serial_message,
				port,
				message,
			)
		)
		for port in ports
	}

	start_server = websockets.serve(handle_websocket_connection, 'localhost', 8069)

	main_thread_loop.run_until_complete(start_server)
	main_thread_loop.run_forever()
