// Voice Activity Detector AudioWorkletProcessor
// This detects voice activity in real-time audio streams

class VoiceDetectorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    
    // Configuration parameters
    this.bufferSize = 1024;
    this.backgroundNoiseLevel = 0;
    this.isCalibrating = true;
    this.calibrationSamples = [];
    this.maxCalibrationSamples = 30;
    this.speakingThreshold = 5;
    
    // Detection state
    this.consecutiveSpeechFrames = 0;
    this.consecutiveSilenceFrames = 0;
    this.isSpeaking = false;
    
    // Log initialization
    console.log('VoiceDetectorProcessor initialized');
  }

  /**
   * Calculate average volume from audio data
   */
  getAverageVolume(inputs) {
    let sum = 0;
    const input = inputs[0][0];
    
    // Sum the absolute values of samples
    for (let i = 0; i < input.length; i++) {
      sum += Math.abs(input[i]);
    }
    
    // Return average scaled to 0-100 range
    return (sum / input.length) * 100;
  }
  
  /**
   * Detect human voice frequencies in the audio
   * This is a simplified version - a real implementation would use FFT
   */
  detectVoiceFrequencies(inputs) {
    // In a full implementation, we would use FFT to analyze frequency content
    // For now, we'll use a simplified approach based on energy and zero crossings
    
    const input = inputs[0][0];
    let zeroCrossings = 0;
    
    // Count zero crossings (sign changes) as a rough frequency indicator
    for (let i = 1; i < input.length; i++) {
      if ((input[i] >= 0 && input[i-1] < 0) || 
          (input[i] < 0 && input[i-1] >= 0)) {
        zeroCrossings++;
      }
    }
    
    // Calculate zero crossing rate
    const zcr = zeroCrossings / (input.length - 1);
    
    // Human speech typically has a moderate zero crossing rate
    // Too low = low frequency noise, too high = high frequency noise
    return (zcr > 0.05 && zcr < 0.2) ? 1.0 : 0.0;
  }

  process(inputs, outputs, parameters) {
    // Check if we have input data
    if (inputs.length === 0 || inputs[0].length === 0) {
      return true;
    }
    
    // Calculate audio metrics
    const volume = this.getAverageVolume(inputs);
    const voiceSignature = this.detectVoiceFrequencies(inputs);
    
    // During calibration, collect background noise samples
    if (this.isCalibrating) {
      this.calibrationSamples.push(volume);
      
      if (this.calibrationSamples.length >= this.maxCalibrationSamples) {
        this.backgroundNoiseLevel = this.calibrationSamples.reduce((a, b) => a + b, 0) / 
                                   this.calibrationSamples.length;
        
        // Add a small buffer to avoid false triggers
        this.backgroundNoiseLevel += 2;
        
        this.isCalibrating = false;
        console.log('Background noise calibrated in worklet:', this.backgroundNoiseLevel);
        
        // Notify the main thread that calibration is complete
        this.port.postMessage({
          type: 'calibration-complete',
          noiseLevel: this.backgroundNoiseLevel
        });
      }
      
      return true;
    }
    
    // Voice activity detection
    // Check if volume is significantly above background noise and has voice characteristics
    const isSpeaking = (volume > this.backgroundNoiseLevel + this.speakingThreshold) && 
                       (voiceSignature > 0.5);
    
    if (isSpeaking) {
      this.consecutiveSpeechFrames++;
      this.consecutiveSilenceFrames = 0;
      
      // Require multiple consecutive speech frames to avoid false positives
      if (this.consecutiveSpeechFrames >= 5 && !this.isSpeaking) {
        this.isSpeaking = true;
        
        // Notify the main thread that speech started
        this.port.postMessage({
          type: 'speech-start',
          volume: volume
        });
      }
    } else {
      this.consecutiveSilenceFrames++;
      this.consecutiveSpeechFrames = 0;
      
      // Require multiple consecutive silence frames to avoid cutting off speech
      if (this.consecutiveSilenceFrames >= 15 && this.isSpeaking) {
        this.isSpeaking = false;
        
        // Notify the main thread that speech ended
        this.port.postMessage({
          type: 'speech-end',
          silenceDuration: this.consecutiveSilenceFrames * 128 / currentFrame.sampleRate * 1000 // in ms
        });
      }
    }
    
    // Send regular volume updates to main thread (every 5 frames)
    if ((this.consecutiveSilenceFrames + this.consecutiveSpeechFrames) % 5 === 0) {
      this.port.postMessage({
        type: 'volume-update',
        volume: volume,
        isSpeaking: this.isSpeaking
      });
    }
    
    // Always continue processing
    return true;
  }
  
  // Allow recalibration from main thread
  recalibrate() {
    this.isCalibrating = true;
    this.calibrationSamples = [];
    console.log('Recalibrating voice detector...');
  }
}

// Register the processor
registerProcessor('voice-detector-processor', VoiceDetectorProcessor);