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
    'id',     # Unique ID among ALL sensors.
    'port',   # Serial port.
    'index',  # Index among sensors for this port.
    'pin',    # Teensy pin.
    'button', # Joystick button.
    'group',  # Group number for UI.
    'label',  # String to label the sensor.
])

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

main_loop = asyncio.get_event_loop()

active_websockets = set()
serial_connections = None

sensor_configs_by_port = None
sensor_configs = []

profiles = {}
active_profile_name = None

VALUE_READ_RATE = 30
SERIAL_VALUES = b'v'[0]
SERIAL_THRESHOLDS = b't'[0]

def json_encode(data):
    return json.dumps(data, separators=(',', ':'))

async def handle_serial_message(port_name, msg):
    kind = msg[0]
    if kind == SERIAL_VALUES:
        values = [int(x) for x in msg[1:].strip().split(b' ')]
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
    elif kind == SERIAL_THRESHOLDS:
        thresholds = [int(x) for x in msg[1:].strip().split(b' ')]
        log.info(f'Received FSR thresholds: {port_name} {thresholds}')

        configs = sensor_configs_by_port[port_name]
        if len(thresholds) != len(configs):
            log.warning(
                f'Received incorrect number of thresholds from port {port_name}: {thresholds}'
            )
            return
    else:
        log.warning(f'Unknown message type: {msg}')

async def broadcast_to_websockets(data):
    if len(active_websockets) == 0:
        return

    message = json_encode(data)
    await asyncio.gather(
        *(
            ws.send(message)
            for ws in active_websockets
        )
    )

async def handle_websocket_message(websocket, msg):
    log.info(f'Received websocket message {msg}')

    try:
        msg_data = json.loads(msg)
    except Exception:
        log.exception(f'Received invalid JSON {msg}')
        return

    try:
        if 'setThreshold' in msg_data:
            update = msg_data['setThreshold']
            id = update['id']
            threshold = update['threshold']
            await set_threshold(id, threshold)

        if 'changeThreshold' in msg_data:
            update = msg_data['changeThreshold']

            id = update['id']
            delta = update['delta']
            await set_threshold(id, profiles[active_profile_name][id] + delta)
        
        if 'setActiveProfile' in msg_data:
            await set_active_profile(msg_data['setActiveProfile'])

    except Exception:
        log.exception(f'Failed to handle message {msg}')

async def set_active_profile(new_active_profile_name):
    global active_profile_name
    active_profile_name = new_active_profile_name

    if active_profile_name not in profiles:
        profiles[active_profile_name] = [500]*len(sensor_configs)

    for id, threshold in enumerate(profiles[active_profile_name]):
        send_threshold_to_serial(id, threshold)

    await broadcast_to_websockets({
        'thresholds': {
            str(id): threshold
            for id, threshold in enumerate(profiles[active_profile_name])
        },
        'activeProfile': active_profile_name,
    })

async def set_threshold(id, threshold):
    profiles[active_profile_name][id] = threshold
    save_profiles()

    # Send new threshold to fsrs
    send_threshold_to_serial(id, threshold)

    # Send new threshold to websockets
    await broadcast_to_websockets({
        'thresholds': { str(id): threshold },
    })


def send_threshold_to_serial(id, threshold):
    if threshold < 0:
        threshold = 1024

    config = sensor_configs[id]
    cmd = str(config.index) + str(threshold) + '\n'
    log.info('Sending threshold update: {config.port} {cmd}')
    serial_connections[config.port].write(cmd.encode('ascii'))


async def handle_websocket_connection(websocket, path):
    active_websockets.add(websocket)

    await websocket.send(json_encode({
        'sensors': [
            {
                'group': config.group,
                'label': config.label,
            }
            for config in sensor_configs
        ],
        'thresholds': {
            str(id): threshold
            for id, threshold in enumerate(profiles[active_profile_name])
        },
        'profiles': list(profiles),
        'activeProfile': active_profile_name,
    }))

    try:
        while True:
            msg = await websocket.recv()
            await handle_websocket_message(websocket, msg)
    finally:
        active_websockets.discard(websocket)

def config_num_to_str(n):
    if n < 10:
        return chr(ord('0') + n)
    else:
        return chr(ord('A') + (n-10))

def send_config_to_ports():
    for port, configs in sensor_configs_by_port.items():
        config_str = ''.join(
            config_num_to_str(config.pin) + config_num_to_str(config.button)
            for config in configs
        )
        cmd = f'c{config_str}\n'
        log.info(f'Sending config update: {port} {cmd}')
        serial_connections[port].write(cmd.encode('ascii'))

def load_sensor_configs():
    global sensor_configs_by_port
    global sensor_configs

    sensor_configs = []
    sensor_configs_by_port = {}
    sensor_id = 0
    with open('sensors.txt', 'r', encoding='utf8') as sensors_file:
        for line_index, line in enumerate(sensors_file.readlines()):
            try:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                parts = line.split(',')
                port, pin, button, group, label = (part.strip() for part in parts)
                pin = int(pin)
                button = int(button)
                group = int(group)

                if port not in sensor_configs_by_port:
                    sensor_configs_by_port[port] = []

                sensor_index = len(sensor_configs_by_port[port])
                config = SensorConfig(
                    id=sensor_id,
                    port=port,
                    index=sensor_index,
                    pin=pin,
                    button=button,
                    group=group,
                    label=label,
                )

                sensor_configs.append(config)
                sensor_configs_by_port[port].append(config)

                sensor_id += 1
            except Exception as e:
                raise RuntimeError(f'Failed to parse sensors.txt line {line_num}') from e


def load_profiles():
    global profiles
    global active_profile_name

    active_profile_name = None

    try:
        with open('profiles.txt', 'r') as f:
            profiles_str = f.read()
    except IOError:
        log.info(f'Profiles file could not be loaded.')
        profiles_str = ''

    profiles = {}

    for line in profiles_str.split('\n'):
        parts = [s.strip() for s in line.split(',')]

        name = parts[0]
        if len(name) == 0:
            continue

        thresholds = [int(s) for s in parts[1:]]

        if len(thresholds) != len(sensor_configs):
            log.warning(f'Adjusting threshold count for profile {name}.')

        while len(thresholds) < len(sensor_configs):
            thresholds.append(500)

        thresholds = thresholds[:len(sensor_configs)]

        profiles[name] = thresholds
        if active_profile_name is None:
            active_profile_name = name

    if active_profile_name is None:
        active_profile_name = 'Guest'
        profiles[active_profile_name] = [500]*len(sensor_configs)

def save_profiles():
    global profiles

    lines = []
    for name in sorted(profiles):
        thresholds = profiles[name]
        lines.append(
            name + ',' + ','.join(map(str, thresholds))
        )

    profiles_str = '\n'.join(lines) + '\n'

    with open('profiles.txt', 'w') as f:
        f.write(profiles_str)

    log.info('Saved profiles.')

async def write_values_commands_forever():
    while True:
        for ser in serial_connections.values():
            ser.write(b'v\n')
        await asyncio.sleep(1/VALUE_READ_RATE)

async def main():
    global serial_connections

    http_server = ThreadingHTTPServer(
        ('', 8000),
        partial(
            SimpleHTTPRequestHandler,
            directory='client',
        )
    )
    threading.Thread(target=http_server.serve_forever).start()

    load_sensor_configs()

    load_profiles()

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

    send_config_to_ports()

    await websockets.serve(handle_websocket_connection, 'localhost', 8069)

    for ser in serial_connections.values():
        ser.write(b't\n')

    main_loop.create_task(write_values_commands_forever())


if __name__ == '__main__':
    main_loop.run_until_complete(main())
    main_loop.run_forever()
