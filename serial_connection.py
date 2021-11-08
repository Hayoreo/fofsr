import threading
import serial

SERIAL_RATE = 115200

class SerialConnection:
	def __init__(self, port_name, message_callback):
		self._serial = serial.Serial(port_name, SERIAL_RATE)
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
			self._message_callback(line)

	def _write_loop(self):
		while True:
			with self._write_condition:
				while len(self._pending_messages) == 0:
					self._write_condition.wait()
				
				messages_to_send = self._pending_messages
				self._pending_messages = []

			for message in messages_to_send:
				self._serial.write(message)
