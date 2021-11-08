import threading
import serial
import logging

log = logging.getLogger(__name__)

SERIAL_RATE = 115200

class SerialConnection:
    def __init__(self, port_name, loop, message_callback):
        self._serial = serial.Serial(port_name, SERIAL_RATE)

        self._port_name = port_name
        self._loop = loop
        self._message_callback = message_callback

        self._pending_messages = []
        self._write_condition = threading.Condition()

        threading.Thread(target=self._read_loop).start()
        threading.Thread(target=self._write_loop).start()

    def write(self, message):
        with self._write_condition:
            self._pending_messages.append(message)
            self._write_condition.notify()

    def _read_loop(self):
        while True:
            line = self._serial.readline()
            if line:
                self._loop.call_soon_threadsafe(self._handle_message, line)

    def _handle_message(self, message):
        self._loop.create_task(
            self._message_callback(
                self._port_name,
                message
            )
        )

    def _write_loop(self):
        while True:
            with self._write_condition:
                while len(self._pending_messages) == 0:
                    self._write_condition.wait()
                
                messages_to_send = self._pending_messages
                self._pending_messages = []

            for message in messages_to_send:
                self._serial.write(message)
