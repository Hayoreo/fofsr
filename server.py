import asyncio
import websockets
import json
from collections import namedtuple
import logging
from serial.tools import list_ports
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial
import threading

from serial_connection import SerialConnection

SensorConfig = namedtuple('SensorConfig', [
    'id',
    'port',
    'pin',
    'panel',
    'label',
])

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

main_loop = asyncio.get_event_loop()

active_websockets = set()
serial_connections = None

sensor_configs_by_port = None
sensor_configs = []

VALUE_READ_RATE = 30
SERIAL_VALUES = b'v'[0]
SERIAL_THRESHOLDS = b't'[0]

def json_encode(data):
    return json.dumps(data, separators=(',', ':'))

async def handle_serial_message(port_name, msg):
    kind = msg[0]
    if kind == SERIAL_VALUES:
        values = list(map(int, msg[1:].strip().split(b' ')))
        configs = sensor_configs_by_port[port_name]
        if len(values) != len(configs):
            log.warning(
                f'Received incorrect number of values from port {port_name}: {values}'
            )
            return
        
        value_updates = {
            str(config.id): value
            for config, value in zip(configs, values)
        }
        await broadcast_to_websockets({
            'values': value_updates,
        })
    else:
        log.warning(f'Unknown message type: {msg}')

async def broadcast_to_websockets(data):
    message = json_encode(data)
    await asyncio.gather(
        *(
            ws.send(message)
            for ws in active_websockets
        )
    )

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
    
    await websocket.send(json_encode({
        'sensors': [
            {
                'label': config.label,
            }
            for config in sensor_configs
        ]
    }))

    try:
        while True:
            msg = await websocket.recv()
            await handle_websocket_message(websocket, msg)
    finally:
        active_websockets.discard(websocket)

def load_sensor_configs():
    global sensor_configs_by_port
    global sensor_configs

    sensor_configs = []
    sensor_index = 0
    with open('sensors.txt', 'r', encoding='utf8') as sensors_file:
        for line_index, line in enumerate(sensors_file.readlines()):
            try:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                parts = line.split(',')
                port, pin, panel, label = (part.strip() for part in parts)
                pin = int(pin)
                panel = int(panel)
                sensor_configs.append(SensorConfig(
                    id=sensor_index,
                    port=port,
                    pin=pin,
                    panel=panel,
                    label=label,
                ))
                sensor_index += 1
            except Exception as e:
                raise RuntimeError(f'Failed to parse sensors.txt line {line_num}') from e

    sensor_configs_by_port = {}
    for config in sensor_configs:
        if config.port not in sensor_configs_by_port:
            sensor_configs_by_port[config.port] = []
        sensor_configs_by_port[config.port].append(config)

async def write_values_command_forever(ser):
    while True:
        ser.write(b'v\n')
        await asyncio.sleep(1/VALUE_READ_RATE)


async def main():
    http_server = ThreadingHTTPServer(
        ('', 8000),
        partial(
            SimpleHTTPRequestHandler,
            directory='client',
        )
    )
    threading.Thread(target=http_server.serve_forever).start()

    load_sensor_configs()
    
    ports = set(sensor_configs_by_port)

    actual_ports = set(port.device for port in list_ports.comports())

    for missing_port in ports - actual_ports:
        log.warning(f'Port {missing_port} is missing!')

    for extra_port in actual_ports - ports:
        log.info(f'(Port {extra_port} is unused)')

    serial_connections = {
        port: SerialConnection(
            port,
            main_loop,
            handle_serial_message,
        )
        for port in ports
    }

    await websockets.serve(handle_websocket_connection, 'localhost', 8069)

    for ser in serial_connections.values():
        main_loop.create_task(write_values_command_forever(ser))


if __name__ == '__main__':
    main_loop.run_until_complete(main())
    main_loop.run_forever()
