#include <inttypes.h>

#ifdef CORE_TEENSY
  // Use the Joystick library for Teensy
  void ButtonStart() {
    // Use Joystick.begin() for everything that's not Teensy 2.0.
    #ifndef __AVR_ATmega32U4__
      Joystick.begin();
    #endif
    Joystick.useManualSend(true);
  }
  void ButtonPress(uint8_t button_num) {
    Joystick.button(button_num, 1);
  }
  void ButtonRelease(uint8_t button_num) {
    Joystick.button(button_num, 0);
  }
#else
  #include <Keyboard.h>
  // And the Keyboard library for Arduino
  void ButtonStart() {
    Keyboard.begin();
  }
  void ButtonPress(uint8_t button_num) {
    Keyboard.press('a' + button_num - 1);
  }
  void ButtonRelease(uint8_t button_num) {
    Keyboard.release('a' + button_num - 1);
  }
#endif

// Default threshold value for each of the sensors.
const int16_t kDefaultThreshold = 1000;
// Max window size for both of the moving averages classes.
const size_t kWindowSize = 50;
// Baud rate used for Serial communication. Technically ignored by Teensys.
const long kBaudRate = 115200;

// We don't want to use digital pins 0 and 1 as they're needed for Serial
// communication.
#define DIGITAL_PIN_OFFSET 2

/*===========================================================================*/

// Calculates the Weighted Moving Average for a given period size.
// Values provided to this class should fall in [−32,768, 32,767] otherwise it
// may overflow. We use a 32-bit integer for the intermediate sums which we
// then restrict back down to 16-bits.
class WeightedMovingAverage {
 public:
  WeightedMovingAverage(size_t size) :
      size_(min(size, kWindowSize)), cur_sum_(0), cur_weighted_sum_(0),
      values_{}, cur_count_(0) {}

  int16_t GetAverage(int16_t value) {
    // Add current value and remove oldest value.
    // e.g. with value = 5 and cur_count_ = 0
    // [4, 3, 2, 1] -> 10 becomes 10 + 5 - 4 = 11 -> [5, 3, 2, 1]
    int32_t next_sum = cur_sum_ + value - values_[cur_count_];
    // Update weighted sum giving most weight to the newest value.
    // [1*4, 2*3, 3*2, 4*1] -> 20 becomes 20 + 4*5 - 10 = 30
    //     -> [4*5, 1*3, 2*2, 3*1]
    // Subtracting by cur_sum_ is the same as removing 1 from each of the weight
    // coefficients.
    int32_t next_weighted_sum = cur_weighted_sum_ + size_ * value - cur_sum_;
    cur_sum_ = next_sum;
    cur_weighted_sum_ = next_weighted_sum;
    values_[cur_count_] = value;
    cur_count_ = (cur_count_ + 1) % size_;
    // Integer division is fine here since both the numerator and denominator
    // are integers and we need to return an int anyways. Off by one isn't
    // substantial here.
    // Sum of weights = sum of all integers from [1, size_]
    return next_weighted_sum/((size_ * (size_ + 1)) / 2);
  }

  // Delete default constructor. Size MUST be explicitly specified.
  WeightedMovingAverage() = delete;

 private:
  size_t size_;
  int32_t cur_sum_;
  int32_t cur_weighted_sum_;
  // Keep track of all values we have in a circular array.
  int16_t values_[kWindowSize];
  size_t cur_count_;
};

// Calculates the Hull Moving Average. This is one of the better smoothing
// algorithms that will smooth the input values without wildly distorting the
// input values while still being responsive to input changes.
//
// The algorithm is essentially:
//   1. Calculate WMA of input values with a period of n/2 and multiply it by 2.
//   2. Calculate WMA of input values with a period of n and subtract it from
//      step 1.
//   3. Calculate WMA of the values from step 2 with a period of sqrt(2).
//
// HMA = WMA( 2 * WMA(input, n/2) - WMA(input, n), sqrt(n) )
class HullMovingAverage {
 public:
  HullMovingAverage(size_t size) :
      wma1_(size/2), wma2_(size), hull_(sqrt(size)) {}

  int16_t GetAverage(int16_t value) {
    int16_t wma1_value = wma1_.GetAverage(value);
    int16_t wma2_value = wma2_.GetAverage(value);
    int16_t hull_value = hull_.GetAverage(2 * wma1_value - wma2_value);

    return hull_value;
  }

 private:
  WeightedMovingAverage wma1_;
  WeightedMovingAverage wma2_;
  WeightedMovingAverage hull_;
};

/*===========================================================================*/

// Class containing all relevant information per sensor.
class ButtonState {
 public:
  ButtonState() :
      state_(ButtonState::OFF)
      {}

  // Fetches the sensor value and maybe triggers the button press/release.
  void EvaluateButton(uint8_t button_num, bool willSend) {
    if (willSend) {
      if (state_ == ButtonState::ON) {
        ButtonPress(button_num);
        digitalWrite(button_num - 1 + DIGITAL_PIN_OFFSET, HIGH);
      }
      else {
        ButtonRelease(button_num);
        digitalWrite(button_num - 1 + DIGITAL_PIN_OFFSET, LOW);
      }
    }
  }

  void Reset() {
    state_ = ButtonState::OFF;
  }

  void SetPressed() {
    state_ = ButtonState::ON;
  }

  // The current joystick state of the sensor.
  enum State { OFF, ON };
 private:
  State state_;
};

/*===========================================================================*/

const size_t MAX_BUTTON_COUNT = 32;
ButtonState kButtonStates[MAX_BUTTON_COUNT];
size_t buttonCount = 0;

/*===========================================================================*/

class SensorState {
  public:
    SensorState()
      : pin_(0)
      , button_(0)
      , user_threshold_(kDefaultThreshold)
      , moving_average_(kWindowSize)
      , state_(ButtonState::OFF)
      , cur_value_(0)
      , offset_(0)

      , sample_min_(1024)
      , sample_max_(-1)
      {}

    void Init(uint8_t pin, uint8_t button) {
      pin_ = pin;
      button_ = button;
      user_threshold_ = kDefaultThreshold;
      state_ = ButtonState::OFF;
      offset_ = 0;
    }

    void EvaluateSensor(unsigned long curMillis) {
      int16_t sensor_value = analogRead(pin_);
      
      // Don't use averaging for Arduino Leonardo, Uno, Mega1280, and Mega2560
      // since averaging seems to be broken with it. This should also include the
      // Teensy 2.0 as it's the same board as the Leonardo.
      // TODO(teejusb): Figure out why and fix. Maybe due to different integer
      // widths?
      #if defined(__AVR_ATmega32U4__) || defined(__AVR_ATmega328P__) || \
          defined(__AVR_ATmega1280__) || defined(__AVR_ATmega2560__)
        cur_value_ = sensor_value - offset_;
      #else
        // Fetch the updated Weighted Moving Average.
        cur_value_ = moving_average_.GetAverage(sensor_value) - offset_;
      #endif

      if (cur_value_ >= user_threshold_ + kPaddingWidth &&
          state_ == ButtonState::OFF) {
        state_ = ButtonState::ON;
        last_trigger_ms_ = curMillis;
      }

      if (cur_value_ < user_threshold_ - kPaddingWidth &&
          state_ == ButtonState::ON) {
        state_ = ButtonState::OFF;
      }

      if (state_ == ButtonState::ON) {
        kButtonStates[button_].SetPressed();
      }

//    if (state_ == ButtonState::OFF && curMillis - last_trigger_ms_ >= 3000) {
//      UpdateOffset();
//    }
      if (cur_value_ < sample_min_)
      {
        sample_min_ = cur_value_;
      }
      if (cur_value_ > sample_max_)
      {
        sample_max_ = cur_value_;
      }
    }

    uint8_t GetButton() {
      return button_;
    }

  void UpdateThreshold(int16_t new_threshold) {
    user_threshold_ = new_threshold;
  }

  int16_t GetThreshold() {
    return user_threshold_;
  }

  int16_t UpdateOffset() {
    // Update the offset with the last read value. UpdateOffset should be
    // called with no applied pressure on the panels so that it will be
    // calibrated correctly.
    offset_ = cur_value_;
    return offset_;
  }

  int16_t GetCurValue() {
    return cur_value_;
  }

  int16_t GetSampleMin() {
    return sample_min_;
  }

  int16_t GetSampleMax() {
    return sample_max_;
  }

  void StartNewSample() {
    sample_min_ = 1024;
    sample_max_ = -1;
  }

  private:
  // One-tailed width size to create a window around user_threshold_ to
  // mitigate fluctuations by noise. 
  // TODO(teejusb): Make this a user controllable variable.
  const int16_t kPaddingWidth = 1;
    // The pin on the Teensy/Arduino corresponding to this sensor.
    uint8_t pin_;
    // The button this sensor applies to.
    uint8_t button_;
  // The user defined threshold value to activate/deactivate this sensor at.
  int16_t user_threshold_;
  // The smoothed moving average calculated to reduce some of the noise. 
  HullMovingAverage moving_average_;
  ButtonState::State state_;
  // The latest value obtained for this sensor.
  int16_t cur_value_;
  // How much to shift the value read by during each read.
  int16_t offset_;
  // Timestamp of when the last time this sensor was triggered.
  unsigned long last_trigger_ms_ = 0;

  int16_t sample_min_;
  int16_t sample_max_;
};

/*===========================================================================*/

const size_t MAX_SENSOR_COUNT = 32;
SensorState kSensorStates[MAX_SENSOR_COUNT];
size_t sensorCount = 0;

/*===========================================================================*/

class SerialProcessor {
 public:
   void Init(long baud_rate) {
    Serial.begin(baud_rate);
  }

  void CheckAndMaybeProcessData() {
    while (Serial.available() > 0) {
      size_t bytes_read = Serial.readBytesUntil(
          '\n', buffer_, kBufferSize - 1);
      buffer_[bytes_read] = '\0';

      if (bytes_read == 0) { return; }
 
      switch(buffer_[0]) {
        case 'o':
        case 'O':
          UpdateOffsets();
          break;
        case 'v':
        case 'V':
          PrintValues();
          break;
        case 't':
        case 'T':
          PrintThresholds();
          break;
        case 'c':
        case 'C':
          UpdateConfig(bytes_read);
          break;
        case 'b':
        case 'B':
          PrintButtons();
          break;
        default:
          UpdateAndPrintThreshold(bytes_read);
          break;
      }
    }  
  }

  uint8_t CharToConfigNum(char c) {
    if ('0' <= c && c <= '9') {
      return c - '0';
    }
    if ('A' <= c && c <= 'Z') {
      return 10 + (c - 'A');
    }
    return 0xff;
  }

  void UpdateConfig(size_t bytes_read) {
    buttonCount = 0;
    sensorCount = 0;

    // Each sensor is pb, where p is pin and b is button.
    // Numbers are encoded as a single char 0-9,A-Z
    size_t bufferIdx = 1;
    while (bufferIdx+1 < bytes_read && sensorCount < MAX_SENSOR_COUNT) {
      uint8_t pin = CharToConfigNum(buffer_[bufferIdx++]);
      uint8_t button = CharToConfigNum(buffer_[bufferIdx++]);

      if (pin == 0xff || button > MAX_BUTTON_COUNT - 1) {
        continue;
      }

      kSensorStates[sensorCount++].Init(pin, button);
      
      if (button + 1u > buttonCount) {
        buttonCount = button + 1;
      }
    }

    for (size_t i = 0; i < buttonCount; i++) {
      kButtonStates[i].Reset();
    }
  }

  void UpdateAndPrintThreshold(size_t bytes_read) {
    // Need to specify:
    // Button number + Threshold value.
    // {0, 1, 2, 3} + "0"-"1023"
    // e.g. 3180 (fourth button, change threshold to 180)
    
    if (bytes_read < 2 || bytes_read > 5) { return; }

    size_t sensor_index = buffer_[0] - '0';
    if (sensor_index >= sensorCount) { return; }

    kSensorStates[sensor_index].UpdateThreshold(
        strtoul(buffer_ + 1, nullptr, 10));
    PrintThresholds();
  }

  void UpdateOffsets() {
    for (size_t i = 0; i < sensorCount; ++i) {
      kSensorStates[i].UpdateOffset();
    }
  }

  void PrintValues() {
    Serial.print("v");
    for (size_t i = 0; i < sensorCount; ++i) {
      Serial.print(" ");
      Serial.print(kSensorStates[i].GetSampleMin());
      Serial.print(" ");
      Serial.print(kSensorStates[i].GetSampleMax());
      kSensorStates[i].StartNewSample();
    }
    Serial.print("\n");
  }

  void PrintThresholds() {
    Serial.print("t");
    for (size_t i = 0; i < sensorCount; ++i) {
      Serial.print(" ");
      Serial.print(kSensorStates[i].GetThreshold());
    }
    Serial.print("\n");
  }

  void PrintButtons() {
    Serial.print("b");
    for (size_t i = 0; i < sensorCount; ++i) {
      Serial.print(" ");
      Serial.print(kSensorStates[i].GetButton());
    }
    Serial.print("\n");
  }

 private:
   static const size_t kBufferSize = 64;
   char buffer_[kBufferSize];
};

/*===========================================================================*/

SerialProcessor serialProcessor;
// Timestamps are always "unsigned long" regardless of board type So don't need
// to explicitly worry about the widths.
unsigned long lastSend = 0;
// loopTime is used to estimate how long it takes to run one iteration of
// loop().
long loopTime = -1;

void setup() {
  serialProcessor.Init(kBaudRate);
  ButtonStart();
  for (size_t i = 0; i < buttonCount; ++i) {
    pinMode(i + DIGITAL_PIN_OFFSET, OUTPUT);
  }
}

void loop() {
  unsigned long startMicros = micros();
  // We only want to send over USB every millisecond, but we still want to
  // read the analog values as fast as we can to have the most up to date
  // values for the average.
  static bool willSend = (loopTime == -1 ||
                          startMicros - lastSend + loopTime >= 1000);

  serialProcessor.CheckAndMaybeProcessData();

  unsigned long curMillis = millis();
  // Reset button values.
  for (size_t i = 0; i < buttonCount; ++i) {
    kButtonStates[i].Reset();
  }
  // Evaluate sensors to apply values to buttons.
  for (size_t i = 0; i < sensorCount; ++i) {
    kSensorStates[i].EvaluateSensor(curMillis);
  }
  // Evaluate buttons with new sensor values.
  for (size_t i = 0; i < buttonCount; ++i) {
    kButtonStates[i].EvaluateButton(i + 1, willSend);
  }

  if (willSend) {
    lastSend = startMicros;
    #ifdef CORE_TEENSY
        Joystick.send_now();
    #endif
  }

  if (loopTime == -1) {
    loopTime = micros() - startMicros;
  }
}
