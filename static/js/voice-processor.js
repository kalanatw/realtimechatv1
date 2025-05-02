// voice-processor.js - AudioWorkletProcessor for voice activity detection
class VoiceActivityProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Initialize processor state
    this.bufferSize = 1024;
    this.bufferCount = 0;
    this.voiceBuffer = new Float32Array(this.bufferSize);
    
    // Shared statistics for voice detection
    this.noiseThreshold = 0.01; // Initial threshold, will be calibrated
    this.calibrating = true;
    this.calibrationSamples = [];
    this.calibrationFramesRemaining = 30; // ~1 second at 30fps
    
    // Speech detection parameters
    this.minConsecutiveVoiceFrames = 3;
    this.consecutiveVoiceFrames = 0;
    this.consecutiveSilenceFrames = 0;
    this.voiceDetected = false;
    
    // Port message handling
    this.port.onmessage = (event) => {
      if (event.data.command === 'setNoiseThreshold') {
        this.noiseThreshold = event.data.threshold;
        this.calibrating = false;
        console.log('VoiceProcessor: Noise threshold set to', this.noiseThreshold);
      } else if (event.data.command === 'startCalibration') {
        this.calibrating = true;
        this.calibrationSamples = [];
        this.calibrationFramesRemaining = 30;
        console.log('VoiceProcessor: Starting calibration');
      }
    };
  }

  process(inputs, outputs, parameters) {
    // Get input data
    const input = inputs[0];
    if (!input || !input.length) return true;
    
    const inputChannel = input[0];
    
    // Calculate signal power/volume
    let sumOfSquares = 0;
    let voiceFrequencyEnergy = 0;
    let totalEnergy = 0.001; // Small non-zero value to prevent division by zero
    
    // Calculate RMS (Root Mean Square) for volume
    for (let i = 0; i < inputChannel.length; i++) {
      sumOfSquares += inputChannel[i] * inputChannel[i];
      
      // Add to buffer for frequency analysis
      this.voiceBuffer[this.bufferCount] = inputChannel[i];
      this.bufferCount = (this.bufferCount + 1) % this.bufferSize;
    }
    
    const rms = Math.sqrt(sumOfSquares / inputChannel.length);
    
    // Perform frequency analysis to identify human voice frequencies
    // This is a simplified spectral analysis - production code would use FFT
    let freqBins = this.simpleFrequencyAnalysis(this.voiceBuffer);
    
    // Human voice is typically 85-255 Hz
    const voiceRangeStart = Math.floor(85 * this.bufferSize / 44100);
    const voiceRangeEnd = Math.ceil(255 * this.bufferSize / 44100);
    
    // Calculate energy in voice frequency range vs total energy
    for (let i = 0; i < freqBins.length; i++) {
      totalEnergy += freqBins[i];
      if (i >= voiceRangeStart && i <= voiceRangeEnd) {
        voiceFrequencyEnergy += freqBins[i];
      }
    }
    
    // Voice signature is the ratio of energy in voice frequency range to total energy
    const voiceSignature = voiceFrequencyEnergy / totalEnergy;
    
    // Update calibration if needed
    if (this.calibrating && this.calibrationFramesRemaining > 0) {
      this.calibrationSamples.push(rms);
      this.calibrationFramesRemaining--;
      
      if (this.calibrationFramesRemaining === 0) {
        // Calculate average noise level
        const averageNoise = this.calibrationSamples.reduce((a, b) => a + b, 0) / 
                             this.calibrationSamples.length;
        // Add a small buffer
        const recommendedThreshold = averageNoise * 2 + 0.01;
        
        // Send result to main thread
        this.port.postMessage({ 
          type: 'calibrationComplete', 
          averageNoise: averageNoise,
          recommendedThreshold: recommendedThreshold
        });
        
        this.calibrating = false;
      }
    }
    
    // Voice activity detection logic
    const isProbablySpeech = (rms > this.noiseThreshold) && (voiceSignature > 0.3);
    
    if (isProbablySpeech) {
      this.consecutiveVoiceFrames++;
      this.consecutiveSilenceFrames = 0;
      
      // Require multiple consecutive frames to trigger voice detected state
      if (!this.voiceDetected && this.consecutiveVoiceFrames >= this.minConsecutiveVoiceFrames) {
        this.voiceDetected = true;
        this.port.postMessage({ type: 'voiceStart', volume: rms, voiceSignature: voiceSignature });
      }
    } else {
      this.consecutiveSilenceFrames++;
      this.consecutiveVoiceFrames = 0;
      
      // Require multiple consecutive frames of silence to end voice detection
      if (this.voiceDetected && this.consecutiveSilenceFrames >= 15) { // About 0.5 second of silence
        this.voiceDetected = false;
        this.port.postMessage({ type: 'voiceEnd', silenceFrames: this.consecutiveSilenceFrames });
      }
    }
    
    // Send regular audio level updates
    if (this.bufferCount % 3 === 0) { // Reduce message frequency
      this.port.postMessage({ 
        type: 'audioLevel', 
        volume: rms,
        voiceSignature: voiceSignature,
        isVoice: this.voiceDetected
      });
    }
    
    // Keep processor alive
    return true;
  }
  
  // Simple frequency analysis - in production, you should use FFT
  simpleFrequencyAnalysis(buffer) {
    const bins = new Array(50).fill(0);
    
    // Very simplified frequency estimation
    for (let i = 0; i < buffer.length - 1; i++) {
      // Detect zero crossings as a very rough frequency indicator
      if ((buffer[i] >= 0 && buffer[i+1] < 0) || 
          (buffer[i] < 0 && buffer[i+1] >= 0)) {
        // Estimate frequency from zero crossing
        const estFreq = 44100 / (i - (buffer.length/2));
        const binIndex = Math.min(Math.floor(estFreq / 50), bins.length - 1);
        if (binIndex >= 0) {
          bins[binIndex] += Math.abs(buffer[i] - buffer[i+1]);
        }
      }
    }
    
    return bins;
  }
}

registerProcessor('voice-activity-processor', VoiceActivityProcessor);