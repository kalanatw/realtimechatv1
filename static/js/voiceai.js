// JavaScript for RealTalk voice conversation application

document.addEventListener('DOMContentLoaded', function() {
    // Get DOM elements
    const recordButton = document.getElementById('recordButton');
    const resetButton = document.getElementById('resetButton');
    const statusIndicator = document.getElementById('statusIndicator');
    const conversationContainer = document.getElementById('conversationContainer');
    const ttsSwitch = document.getElementById('ttsSwitch');
    const topicsList = document.getElementById('topicsList');
    const topicsContainer = document.getElementById('topicsContainer');
    const useWebSocketCheckbox = document.getElementById('useWebSocket');
    
    // Hide record and reset buttons for voice-only experience
    recordButton.style.display = 'none';
    resetButton.style.display = 'none';
    
    // MediaRecorder variables
    let mediaRecorder;
    let audioChunks = [];
    let isRecording = false;
    let stream;
    
    // Speech recognition variables
    let isListening = false;
    let isSpeaking = false;
    let silenceTimer = null;
    let silenceTimeout = 5000; // Increased to 2 seconds for longer pause
    let audioContext;
    let analyser;
    let scriptProcessor;
    let currentAudio = null;
    let latestRequestId = 0; // Track the latest request for response handling
    let isProcessingRequest = false; // Track if a request is currently being processed
    
    // Noise detection and filtering variables
    let backgroundNoiseLevel = 0;
    let voiceActivityDetected = false;
    let calibrationSamples = [];
    let isCalibrated = false;
    let speakingTriggerCount = 0;
    let consecutiveSilenceCount = 0;
    
    // Conversation tracking for agent memory
    let currentConversationId = null;
    
    // WebSocket client
    let wsClient = null;
    let usingWebSockets = false;
    
    // Initialize audio context for playback and analysis
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    // Add overlay for user gesture to start audio context
    const overlay = document.createElement('div');
    overlay.id = 'voiceai-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = 0;
    overlay.style.left = 0;
    overlay.style.width = '100vw';
    overlay.style.height = '100vh';
    overlay.style.background = 'rgba(0,0,0,0.85)';
    overlay.style.color = '#fff';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = 9999;
    overlay.style.fontSize = '2rem';
    overlay.innerText = 'Click anywhere to start voice assistant';
    document.body.appendChild(overlay);

    // Only start audio after user gesture
    overlay.addEventListener('click', function() {
        overlay.style.display = 'none';
        audioContext.resume().then(() => {
            console.log('AudioContext resumed after user gesture');
            initializeAudio();
            
            // Initialize WebSocket if enabled
            if (useWebSocketCheckbox && useWebSocketCheckbox.checked) {
                initializeWebSocket();
            }
        });
    });
    
    // Add event listener for WebSocket toggle
    if (useWebSocketCheckbox) {
        useWebSocketCheckbox.addEventListener('change', function() {
            const useWS = this.checked;
            if (useWS && !wsClient) {
                initializeWebSocket();
            } else if (!useWS && wsClient) {
                wsClient.disconnect();
                wsClient = null;
                usingWebSockets = false;
                console.log('WebSocket connection disabled');
            }
        });
    }
    
    /**
     * Initialize WebSocket connection
     */
    function initializeWebSocket() {
        if (window.VoiceWebSocketClient === undefined) {
            console.error('VoiceWebSocketClient is not available. Make sure to include voiceai-websocket.js');
            if (useWebSocketCheckbox) {
                useWebSocketCheckbox.checked = false;
            }
            return;
        }
        
        try {
            // Get TTS preferences
            const useOfflineTTS = ttsSwitch.checked;
            const ttsEngine = document.getElementById('ttsEngine').value;
            
            // Initialize WebSocket client
            wsClient = new VoiceWebSocketClient({
                useStreaming: true, // Use streaming mode
                useOfflineTTS: useOfflineTTS,
                ttsEngine: ttsEngine,
                
                // Set up callbacks
                onOpen: () => {
                    usingWebSockets = true;
                    console.log('WebSocket connection established');
                    statusIndicator.textContent = 'WebSocket connected, listening for your voice...';
                    
                    // Set conversation ID if we have one
                    if (currentConversationId) {
                        wsClient.setConversationId(currentConversationId);
                    }
                },
                
                onClose: () => {
                    usingWebSockets = false;
                    console.log('WebSocket connection closed');
                    
                    // Only update status if not in middle of other operation
                    if (!isProcessingRequest && !isRecording) {
                        statusIndicator.textContent = 'WebSocket disconnected, using HTTP fallback...';
                    }
                },
                
                onError: (error) => {
                    console.error('WebSocket error:', error);
                    
                    // Only update status if not in middle of other operation
                    if (!isProcessingRequest && !isRecording) {
                        statusIndicator.textContent = 'WebSocket error, using HTTP fallback...';
                    }
                    
                    // Fallback to HTTP mode
                    usingWebSockets = false;
                },
                
                onTranscription: (text) => {
                    // Update user bubble with transcription
                    updateLastUserBubble(text);
                },
                
                onAIResponse: (text, conversationId, toolUsed) => {
                    // Add the AI response bubble
                    const responseBubble = addMessageBubble('ai', text);
                    
                    // Update conversation ID
                    if (conversationId) {
                        currentConversationId = conversationId;
                    }
                    
                    // Show tool usage if applicable
                    if (toolUsed) {
                        const toolIndicator = document.createElement('div');
                        toolIndicator.classList.add('tool-indicator');
                        toolIndicator.innerHTML = `<small class="text-info"><i class="fas fa-tools"></i> Used: ${toolUsed}</small>`;
                        conversationContainer.appendChild(toolIndicator);
                        conversationContainer.scrollTop = conversationContainer.scrollHeight;
                    }
                    
                    // Update topics list
                    updateTopicsList(text);
                },
                
                onAudio: (audioUrl, audioBlob) => {
                    // Play the audio response
                    const audio = new Audio(audioUrl);
                    playAudioResponse(audio);
                },
                
                onTTSSegment: (audioData) => {
                    // For streaming TTS, add to audio queue
                    audioQueue.addSegment(audioData);
                },
                
                onComplete: () => {
                    // Update status
                    statusIndicator.textContent = 'Listening for your voice...';
                    isProcessingRequest = false;
                }
            });
            
            console.log('WebSocket client initialized');
            
        } catch (error) {
            console.error('Error initializing WebSocket client:', error);
            usingWebSockets = false;
            if (useWebSocketCheckbox) {
                useWebSocketCheckbox.checked = false;
            }
        }
    }
    
    /**
     * Initialize audio recording capabilities with voice activity detection
     */
    function initializeAudio() {
        console.log('Initializing audio...');
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            navigator.mediaDevices.getUserMedia({ audio: { 
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }})
                .then(str => {
                    console.log('Microphone access granted');
                    stream = str;
                    
                    // Create MediaRecorder instance
                    mediaRecorder = new MediaRecorder(stream);
                    
                    // Set up event handlers for MediaRecorder
                    mediaRecorder.ondataavailable = handleDataAvailable;
                    mediaRecorder.onstop = handleRecordingStop;
                    
                    // Create audio nodes for voice activity detection
                    setupVoiceActivityDetection(stream);
                    
                    // Calibrate background noise before starting
                    calibrateBackgroundNoise();
                    
                    // Update UI
                    statusIndicator.textContent = 'Calibrating background noise...';
                    statusIndicator.classList.add('listening-active');
                })
                .catch(error => {
                    console.error('Error accessing microphone:', error);
                    statusIndicator.textContent = 'Error: Microphone access denied. Please allow microphone access.';
                    statusIndicator.classList.add('text-danger');
                });
        } else {
            console.error('MediaDevices API not supported in this browser');
            statusIndicator.textContent = 'Error: Your browser does not support voice recording.';
            statusIndicator.classList.add('text-danger');
        }
    }
    
    /**
     * Calibrate background noise level before starting to listen
     * with improved accuracy
     */
    function calibrateBackgroundNoise() {
        let calibrationCount = 0;
        const maxCalibrationSamples = 45; // Increased from 30 to 45 for better calibration
        console.log('Calibrating background noise...');
        
        // Clear previous samples
        calibrationSamples = [];
        
        const calibrationInterval = setInterval(() => {
            if (calibrationCount >= maxCalibrationSamples) {
                clearInterval(calibrationInterval);
                
                // Sort samples to filter out outliers
                calibrationSamples.sort((a, b) => a - b);
                
                // Remove outliers (top and bottom 15%)
                const trimStart = Math.floor(calibrationSamples.length * 0.15);
                const trimEnd = Math.floor(calibrationSamples.length * 0.85);
                const trimmedSamples = calibrationSamples.slice(trimStart, trimEnd);
                
                // Calculate the average background noise level
                backgroundNoiseLevel = trimmedSamples.reduce((a, b) => a + b, 0) / trimmedSamples.length;
                console.log('Background noise level calibrated:', backgroundNoiseLevel);
                
                // Add a larger buffer to avoid false triggers
                backgroundNoiseLevel += 5; // Increased from 2 to 5
                
                isCalibrated = true;
                
                // Now start the auto listening mode
                startAutoListeningMode();
                
                // Update UI
                statusIndicator.textContent = 'Listening for your voice...';
            } else {
                const array = new Uint8Array(analyser.frequencyBinCount);
                analyser.getByteFrequencyData(array);
                calibrationSamples.push(getAverageVolume(array));
                calibrationCount++;
            }
        }, 33); // ~30 samples per second
    }
    
    /**
     * Set up voice activity detection to automatically detect speech and silence
     */
    function setupVoiceActivityDetection(stream) {
        // Create audio source from the microphone stream
        const source = audioContext.createMediaStreamSource(stream);
        
        // Create an analyser to analyze audio levels
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 1024; // Increased for better frequency resolution
        analyser.smoothingTimeConstant = 0.3; // Increased for more stable detection (was 0.2)
        
        // Connect the source to the analyser
        source.connect(analyser);
        
        // Create a processor to monitor audio levels
        scriptProcessor = audioContext.createScriptProcessor(1024, 1, 1);
        analyser.connect(scriptProcessor);
        scriptProcessor.connect(audioContext.destination);
        
        // Add debounce for speech detection to prevent rapid toggling
        let lastSpeechState = false;
        let speechStateCounter = 0;
        let silenceStateCounter = 0;
        const STATE_CHANGE_THRESHOLD = 5; // Require more consecutive frames to change state
        
        // Set up processing to detect voice activity
        scriptProcessor.onaudioprocess = function() {
            // Always analyze audio for voice activity
            const array = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(array);
            
            // Get average volume level
            const average = getAverageVolume(array);
            
            // Get speech frequency signature (human voice is typically 85-255 Hz)
            const voiceFrequencySignature = getVoiceFrequencySignature(array);
            
            // Debug logs (uncomment if needed)
            // console.log('Audio process: avg', average, 'bgNoise', backgroundNoiseLevel, 'voiceSig', voiceFrequencySignature, 'isRecording', isRecording, 'isListening', isListening);
            
            // For visualization
            if (isRecording) {
                updateVolumeIndicator(average);
            }
            
            // Is the current audio above background noise and has speech frequencies?
            const isSpeakingNow = (average > backgroundNoiseLevel + 10) && (voiceFrequencySignature > 0.3);
            
            // If we're recording, handle silence detection
            if (isRecording) {
                if (isSpeakingNow) {
                    // Reset silence detection
                    if (silenceTimer !== null) {
                        clearTimeout(silenceTimer);
                        silenceTimer = null;
                    }
                    
                    // Reset silence counter but with debounce
                    silenceStateCounter = 0;
                    
                    // Increment speech counter to prevent premature cutoffs during pauses
                    speechStateCounter = Math.min(speechStateCounter + 1, 30); // Cap at 30
                } else {
                    // Count consecutive silence frames with debounce
                    silenceStateCounter++;
                    speechStateCounter = Math.max(speechStateCounter - 1, 0);
                    
                    // Only trigger silence timeout if we've had significant silent frames
                    // and speech counter is low (meaning we're not in the middle of a speech)
                    if (silenceStateCounter > 25 && speechStateCounter < 5 && !silenceTimer) {
                        // Increased from 15 to 25 frames to allow longer natural pauses
                        silenceTimer = setTimeout(() => {
                            if (isRecording) {
                                console.log('Silence detected, stopping recording');
                                stopRecording();
                            }
                        }, silenceTimeout);
                    }
                }
            } 
            // If we're not recording but listening, detect when to start with debounce
            else if (isListening && !isSpeaking && !isProcessingRequest) {
                if (isSpeakingNow) {
                    speechStateCounter++;
                    
                    // Require more consecutive speech frames for a more reliable trigger
                    if (speechStateCounter >= 3) { // Changed from 2 to 3 for more reliability
                        if (!lastSpeechState) {
                            console.log('Speech detected, starting recording. Volume:', average, 'Voice signature:', voiceFrequencySignature);
                            lastSpeechState = true;
                            startRecording();
                        }
                    }
                } else {
                    speechStateCounter = Math.max(speechStateCounter - 1, 0);
                    
                    // Only change state after consecutive non-speech frames
                    if (speechStateCounter === 0 && lastSpeechState) {
                        lastSpeechState = false;
                    }
                }
            }
        };
    }
    
    /**
     * Calculate average volume from frequency data with outlier rejection
     */
    function getAverageVolume(array) {
        let values = [];
        const length = array.length;
        
        // Use the frequency data to calculate volume
        for (let i = 0; i < length; i++) {
            values.push(array[i]);
        }
        
        // Sort values and remove extreme outliers
        values.sort((a, b) => a - b);
        const trimLength = Math.floor(length * 0.1); // Trim 10% from each end
        const trimmedValues = values.slice(trimLength, length - trimLength);
        
        // Calculate average of trimmed values
        const sum = trimmedValues.reduce((a, b) => a + b, 0);
        return sum / trimmedValues.length;
    }
    
    /**
     * Extract the voice frequency signature to better distinguish speech from noise
     * with enhanced detection
     */
    function getVoiceFrequencySignature(frequencyData) {
        // Human voice typically falls between 85-255 Hz
        // Given fftSize of 1024, and sampling rate of 44100Hz,
        // each bin represents ~43Hz, so voice is roughly between bins 2-6
        
        const sampleRate = 44100; // Standard sample rate
        const nyquist = sampleRate / 2;
        const binSize = nyquist / frequencyData.length;
        
        let voiceSum = 0;
        let totalSum = 0.01; // Small value to avoid division by zero
        
        // Sum all frequency energies for comparison
        for (let i = 0; i < frequencyData.length; i++) {
            const binValue = frequencyData[i];
            totalSum += binValue;
            
            // Calculate the frequency of this bin
            const frequency = i * binSize;
            
            // Check if this frequency is in the human voice range (85-255 Hz)
            // Give higher weight to the core speech frequencies
            if (frequency >= 85 && frequency <= 255) {
                // Core speech frequencies get more weight
                voiceSum += binValue * 1.5;
            }
            
            // Add some weight to formant frequencies (up to 3000 Hz)
            else if (frequency > 255 && frequency <= 3000) {
                voiceSum += binValue * 0.5;
            }
        }
        
        // Return the weighted ratio of voice frequencies to all frequencies
        return voiceSum / totalSum;
    }
    
    /**
     * Update visual volume indicator
     */
    function updateVolumeIndicator(volume) {
        // Only update when recording
        if (!isRecording) return;
        
        // Update record button styles based on volume
        const scaleFactor = Math.min(1 + (volume / 100), 1.5);
        recordButton.style.transform = `scale(${scaleFactor})`;
        
        // You could also add a volume meter element if desired
    }
    
    /**
     * Start auto-listening mode where the system actively listens for speech
     */
    function startAutoListeningMode() {
        isListening = true;
        console.log('Auto listening mode started');
        
        // Visual indicator that system is listening
        recordButton.classList.add('listening-mode');
        statusIndicator.textContent = 'Listening for your voice...';
    }
    
    // Rest of your existing functions below (handleDataAvailable, handleRecordingStop, etc)...
    
    /**
     * Handle data available from the MediaRecorder
     */
    function handleDataAvailable(event) {
        if (event.data.size > 0) {
            audioChunks.push(event.data);
        }
    }
    
    /**
     * Handle the stop event of the MediaRecorder
     */
    function handleRecordingStop() {
        statusIndicator.textContent = 'Processing your message...';
        
        // Create a blob from the audio chunks
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        
        // If using WebSockets, send via WebSocket
        if (usingWebSockets && wsClient && wsClient.isConnected) {
            // Add a user message bubble with loading state
            addMessageBubble('user', '...', true);
            
            // Send the audio via WebSocket
            wsClient.sendAudio(audioBlob);
        } else {
            // Fall back to HTTP
            sendAudioToServer(audioBlob);
        }
        
        // Reset audio chunks for next recording
        audioChunks = [];
    }
    
    /**
     * Start the recording process
     * with optimized responsiveness
     */
    function startRecording() {
        if (isRecording || isProcessingRequest) return; // Prevent duplicate starts
        
        // Add extra check to ensure we don't start recording if processing is happening
        if (isProcessingRequest) {
            console.log('Cannot start recording while processing a request');
            return;
        }
        
        isRecording = true;
        audioChunks = [];
        
        // Use a shorter delay to start recording faster
        setTimeout(() => {
            try {
                // Use a larger timeslice for better audio quality with less overhead
                mediaRecorder.start(100); // Changed from 10ms to 100ms
                
                // Update UI for recording state
                recordButton.innerHTML = '<i class="fas fa-stop"></i>';
                recordButton.classList.remove('btn-primary');
                recordButton.classList.add('btn-warning', 'recording-active');
                document.body.classList.add('recording');
                statusIndicator.textContent = 'Recording...';
                
                // Reset silence detection
                if (silenceTimer) {
                    clearTimeout(silenceTimer);
                    silenceTimer = null;
                }
                
                // Reset counters
                consecutiveSilenceCount = 0;
            } catch (e) {
                console.error('Failed to start recording:', e);
                isRecording = false;
                statusIndicator.textContent = 'Failed to start recording. Please try again.';
            }
        }, 100); // Reduced from 200ms to 100ms for faster response
    }
    
    /**
     * Stop the recording process
     */
    function stopRecording() {
        if (!isRecording) return; // Prevent errors if not recording
        
        isRecording = false;
        mediaRecorder.stop();
        
        // Update UI back to listening state
        recordButton.innerHTML = '<i class="fas fa-microphone"></i>';
        recordButton.classList.remove('btn-warning', 'recording-active');
        recordButton.classList.add('btn-primary');
        recordButton.style.transform = 'scale(1)';
        document.body.classList.remove('recording');
        
        // Clear any silence timers
        if (silenceTimer) {
            clearTimeout(silenceTimer);
            silenceTimer = null;
        }
        
        // Reset counters
        consecutiveSilenceCount = 0;
        speakingTriggerCount = 0;
    }
    
    // ... rest of existing functions

    /**
     * Send the recorded audio to the server for processing
     * with optimized streaming response handling
     */
    function sendAudioToServer(audioBlob) {
        latestRequestId += 1;
        const thisRequestId = latestRequestId;
        isProcessingRequest = true; // Set flag to indicate request is in progress
        
        // Create FormData to send the audio file
        const formData = new FormData();
        formData.append('audio', audioBlob, 'recording.webm');
        formData.append('use_offline_tts', ttsSwitch.checked);
        
        // Add TTS engine selection
        const ttsEngine = document.getElementById('ttsEngine').value;
        formData.append('tts_engine', ttsEngine);
        
        // Request streaming response for faster feedback
        formData.append('stream_response', 'true');
        
        // Add conversation ID if we have one to maintain context
        if (currentConversationId) {
            formData.append('conversation_id', currentConversationId);
            console.log('Continuing conversation:', currentConversationId);
        } else {
            console.log('Starting new conversation');
        }
        
        // Display user's audio bubble with loading state
        addMessageBubble('user', '...', true);
        
        // Record start time to measure performance
        const requestStartTime = performance.now();
        
        // Send to server
        fetch('/api/converse/', {
            method: 'POST',
            body: formData
        })
        .then(response => {
            if (!response.ok) {
                throw new Error('Network response was not ok');
            }
            return response.json();
        })
        .then(data => {
            if (data.success) {
                // Measure response time
                const responseTime = ((performance.now() - requestStartTime) / 1000).toFixed(2);
                console.log(`Server response received in ${responseTime}s`);
                
                // Only update UI if this is the latest request
                if (thisRequestId === latestRequestId) {
                    // Update the user's message with the transcription
                    updateLastUserBubble(data.transcribed_text);
                    
                    // Add the AI's response immediately
                    const responseBubble = addMessageBubble('ai', data.ai_response);
                    
                    // Begin playing the audio as soon as possible
                    if (data.audio_url) {
                        // Play with progressive loading
                        const audio = new Audio();
                        audio.src = data.audio_url;
                        
                        // Track when playback starts
                        const playbackStartTime = performance.now();
                        audio.oncanplaythrough = function() {
                            const loadTime = ((performance.now() - playbackStartTime) / 1000).toFixed(2);
                            console.log(`Audio ready to play after ${loadTime}s`);
                        };
                        
                        playAudioResponse(audio);
                    }
                    
                    // Save the conversation ID for context in future exchanges
                    if (data.conversation_id) {
                        currentConversationId = data.conversation_id;
                        console.log('Conversation ID updated:', currentConversationId);
                        
                        // Update the WebSocket client with the new conversation ID
                        if (wsClient) {
                            wsClient.setConversationId(currentConversationId);
                        }
                    }
                    
                    // Show what tool was used if applicable
                    if (data.tool_used) {
                        const toolIndicator = document.createElement('div');
                        toolIndicator.classList.add('tool-indicator');
                        toolIndicator.innerHTML = `<small class="text-info"><i class="fas fa-tools"></i> Used: ${data.tool_used}</small>`;
                        conversationContainer.appendChild(toolIndicator);
                        conversationContainer.scrollTop = conversationContainer.scrollHeight;
                    }
                    
                    // Show processing time
                    if (data.processing_time) {
                        statusIndicator.textContent = `Response took ${data.processing_time}s`;
                        
                        // Add performance monitoring in the UI
                        if (responseTime > 0 && data.processing_time > 0) {
                            const clientDelay = (responseTime - data.processing_time).toFixed(2);
                            console.log(`Client-side delay: ${clientDelay}s`);
                        }
                    }
                    
                    // Update topics list
                    updateTopicsList(data.ai_response);
                } else {
                    // Ignore outdated responses
                    console.log('Ignored outdated response', thisRequestId);
                }
            } else {
                statusIndicator.textContent = 'Error: ' + data.error;
                statusIndicator.classList.add('text-danger');
                
                // Resume listening
                setTimeout(() => {
                    statusIndicator.textContent = 'Listening...';
                    statusIndicator.classList.remove('text-danger');
                }, 3000);
            }
        })
        .catch(error => {
            console.error('Error sending audio to server:', error);
            statusIndicator.textContent = 'Error: Failed to process your message.';
            statusIndicator.classList.add('text-danger');
            
            // Resume listening after error
            setTimeout(() => {
                statusIndicator.textContent = 'Listening...';
                statusIndicator.classList.remove('text-danger');
            }, 3000);
        })
        .finally(() => {
            isProcessingRequest = false; // Reset flag when request is complete
        });
    }

    /**
     * Add a message bubble to the conversation container
     */
    function addMessageBubble(sender, message, isLoading = false) {
        // Create the message bubble element
        const bubble = document.createElement('div');
        bubble.classList.add('message-bubble', sender === 'user' ? 'user-bubble' : 'ai-bubble');
        
        // Add a loading spinner if this is a placeholder during loading
        if (isLoading) {
            bubble.innerHTML = `
                <div class="message-content">
                    <div class="loading-indicator">
                        <div class="spinner-border spinner-border-sm text-${sender === 'user' ? 'light' : 'primary'}" role="status">
                            <span class="visually-hidden">Loading...</span>
                        </div>
                        <span class="loading-text">${sender === 'user' ? 'Transcribing...' : 'Thinking...'}</span>
                    </div>
                </div>
                <div class="message-timestamp">${formatTimestamp()}</div>
            `;
        } else {
            bubble.innerHTML = `
                <div class="message-content">${message}</div>
                <div class="message-timestamp">${formatTimestamp()}</div>
            `;
        }
        
        // Add an avatar icon for AI messages
        if (sender === 'ai') {
            const avatarDiv = document.createElement('div');
            avatarDiv.classList.add('ai-avatar');
            avatarDiv.innerHTML = '<i class="fas fa-robot"></i>';
            bubble.prepend(avatarDiv);
        }
        
        // Append to the conversation container
        conversationContainer.appendChild(bubble);
        
        // Scroll to the bottom to show the new message
        conversationContainer.scrollTop = conversationContainer.scrollHeight;
        
        return bubble;
    }
    
    /**
     * Format a timestamp for message bubbles
     */
    function formatTimestamp() {
        const now = new Date();
        return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    
    /**
     * Update the last user bubble with transcribed text
     */
    function updateLastUserBubble(text) {
        const userBubbles = document.querySelectorAll('.user-bubble');
        if (userBubbles.length > 0) {
            const lastBubble = userBubbles[userBubbles.length - 1];
            lastBubble.querySelector('.message-content').innerHTML = text;
        }
    }
    
    /**
     * Play the audio response from the server and handle state
     * with optimized playback
     */
    function playAudioResponse(audioOrUrl) {
        // Set speaking state to true
        isSpeaking = true;
        statusIndicator.textContent = 'AI is speaking...';
        
        // Configure audio element
        let audio;
        if (typeof audioOrUrl === 'string') {
            // Create new Audio element if we received a URL
            audio = new Audio(audioOrUrl);
        } else {
            // Use the provided Audio element
            audio = audioOrUrl;
        }
        
        currentAudio = audio;
        
        // Use lower audio buffer size for faster startup
        audio.preload = 'auto';
        audio.autoplay = true;
        
        // When audio ends, resume listening immediately
        audio.onended = function() {
            isSpeaking = false;
            currentAudio = null;
            statusIndicator.textContent = 'Listening for your voice...';
            console.log('AI response finished, listening for user input');
            
            // Recalibrate the background noise level to adapt to changing environments
            recalibrateBackgroundNoise();
        };
        
        // If audio errors, reset state
        audio.onerror = function() {
            console.error('Error playing audio');
            isSpeaking = false;
            currentAudio = null;
            statusIndicator.textContent = 'Listening for your voice...';
            
            // Ensure we're in auto-listening mode even if audio fails
            if (!isListening) {
                startAutoListeningMode();
            }
        };
        
        // Play the audio
        try {
            const playPromise = audio.play();
            if (playPromise !== undefined) {
                playPromise.catch(error => {
                    console.error('Error playing audio:', error);
                    isSpeaking = false;
                    currentAudio = null;
                    statusIndicator.textContent = 'Listening for your voice...';
                    
                    // Ensure we're in auto-listening mode even if audio fails to play
                    if (!isListening) {
                        startAutoListeningMode();
                    }
                });
            }
        } catch (error) {
            console.error('Error during audio playback:', error);
            isSpeaking = false;
            currentAudio = null;
            statusIndicator.textContent = 'Listening for your voice...';
        }
    }
    
    /**
     * Recalibrate the background noise level to adapt to changing environments
     */
    function recalibrateBackgroundNoise() {
        // Quickly sample the current background noise level without stopping listening
        calibrationSamples = [];
        let recalibrationCount = 0;
        const maxRecalibrationSamples = 15; // Fewer samples for recalibration
        
        const recalibrationInterval = setInterval(() => {
            if (recalibrationCount >= maxRecalibrationSamples) {
                clearInterval(recalibrationInterval);
                
                // Calculate the new background noise level
                const newNoiseLevel = calibrationSamples.reduce((a, b) => a + b, 0) / calibrationSamples.length;
                
                // Only update if the change is significant and not too high (would indicate speech)
                if (newNoiseLevel < backgroundNoiseLevel * 1.5) {
                    console.log('Recalibrated noise level from', backgroundNoiseLevel, 'to', newNoiseLevel);
                    backgroundNoiseLevel = newNoiseLevel + 2; // Add small buffer
                }
            } else {
                // Only use samples for recalibration if we're not detecting voice
                const array = new Uint8Array(analyser.frequencyBinCount);
                analyser.getByteFrequencyData(array);
                const avg = getAverageVolume(array);
                const voiceSignature = getVoiceFrequencySignature(array);
                
                // Only collect samples that are likely not speech
                if (voiceSignature < 0.3) {
                    calibrationSamples.push(avg);
                    recalibrationCount++;
                }
            }
        }, 33);
    }
    
    /**
     * Reset the conversation context (start fresh)
     */
    function resetConversation() {
        currentConversationId = null;
        console.log('Conversation reset');
        
        // Reset the WebSocket client's conversation ID
        if (wsClient) {
            wsClient.setConversationId(null);
        }
        
        // Stop any playing audio
        if (currentAudio) {
            currentAudio.pause();
            currentAudio = null;
            isSpeaking = false;
        }
        
        // Clear the conversation display
        while (conversationContainer.firstChild) {
            conversationContainer.removeChild(conversationContainer.firstChild);
        }
        
        // Add initial greeting
        addMessageBubble('ai', 'How can I help you today? I\'m listening for your voice.');
        
        // Update status
        statusIndicator.textContent = 'Listening for a new conversation...';
        
        // Recalibrate background noise
        recalibrateBackgroundNoise();
    }
    
    // Extract topics from AI responses
    function updateTopicsList(aiResponse) {
        // Only implement if topicsList element exists
        if (!topicsList) return;
        
        // Only show topics container when we have topics
        if (topicsContainer && topicsContainer.classList.contains('d-none')) {
            topicsContainer.classList.remove('d-none');
        }
        
        // Very simple regex-based extraction - this could be enhanced
        const topics = [];
        
        // Look for key phrases and capitalized terms
        const keyTopics = aiResponse.match(/(?:\b(?:regarding|about|topic of|discussing|talking about|mentioned) )([A-Z][a-z]+(?: [a-z]+){0,3})/g);
        const capitalizedTerms = aiResponse.match(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+){0,3}\b/g);
        
        // Add extracted topics to our list
        if (keyTopics) {
            keyTopics.forEach(match => {
                const parts = match.split(' ');
                const topic = parts.slice(1).join(' ');
                if (topic && !topics.includes(topic)) {
                    topics.push(topic);
                }
            });
        }
        
        if (capitalizedTerms) {
            capitalizedTerms.forEach(term => {
                if (term && term.length > 3 && !topics.includes(term)) {
                    topics.push(term);
                }
            });
        }
        
        // Add topics to list if found
        if (topics.length > 0) {
            const topicsSet = new Set(topics);
            topicsSet.forEach(topic => {
                // Check if this topic already exists
                const existingTopic = Array.from(topicsList.children).find(li => li.textContent === topic);
                if (!existingTopic) {
                    const li = document.createElement('li');
                    li.textContent = topic;
                    li.addEventListener('click', () => {
                        // Clicking a topic starts a new question about it
                        startRecording();
                    });
                    topicsList.appendChild(li);
                }
            });
        }
    }

    // Listen for reset button clicks
    if (resetButton) {
        resetButton.addEventListener('click', resetConversation);
    }
    
    // Listen for TTS switch changes
    if (ttsSwitch) {
        ttsSwitch.addEventListener('change', function() {
            // Update WebSocket client with new preference
            if (wsClient) {
                wsClient.options.useOfflineTTS = this.checked;
                // Send updated metadata
                wsClient.sendMetadata();
            }
        });
    }
    
    // Listen for TTS engine changes
    const ttsEngineSelect = document.getElementById('ttsEngine');
    if (ttsEngineSelect) {
        ttsEngineSelect.addEventListener('change', function() {
            // Update WebSocket client with new preference
            if (wsClient) {
                wsClient.options.ttsEngine = this.value;
                // Send updated metadata
                wsClient.sendMetadata();
            }
        });
    }

    // Initial conversation greeting
    addMessageBubble('ai', 'How can I help you today? I\'m listening for your voice.');
});

/**
 * Audio queue for progressive playback of TTS segments
 */
class AudioQueue {
    constructor() {
        this.queue = [];
        this.isPlaying = false;
        this.currentAudio = null;
        this.onComplete = null;
        this.segmentsPlayed = 0;
        this.totalSegments = 0;
    }
    
    addSegment(audioData) {
        // Convert binary data to a playable audio element
        const blob = new Blob([audioData], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        
        // Add to queue
        this.queue.push({
            audio: audio,
            url: url
        });
        
        // Start playback if not already playing
        if (!this.isPlaying) {
            this.playNext();
        }
    }
    
    playNext() {
        if (this.queue.length === 0) {
            this.isPlaying = false;
            
            // Execute completion callback if defined
            if (typeof this.onComplete === 'function') {
                this.onComplete();
            }
            return;
        }
        
        this.isPlaying = true;
        const segment = this.queue.shift();
        this.currentAudio = segment.audio;
        
        // Configure audio element
        this.currentAudio.onended = () => {
            // Clean up resources
            URL.revokeObjectURL(segment.url);
            this.segmentsPlayed++;
            
            // Play the next segment
            this.playNext();
        };
        
        // Handle errors
        this.currentAudio.onerror = (e) => {
            console.error("Error playing audio segment:", e);
            URL.revokeObjectURL(segment.url);
            this.playNext(); // Skip to next segment
        };
        
        // Play this segment
        this.currentAudio.play().catch(error => {
            console.error("Error starting audio playback:", error);
            this.playNext(); // Try the next segment
        });
    }
    
    stop() {
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio = null;
        }
        
        // Clean up all queued segments
        this.queue.forEach(segment => {
            URL.revokeObjectURL(segment.url);
        });
        
        this.queue = [];
        this.isPlaying = false;
    }
    
    setTotalSegments(count) {
        this.totalSegments = count;
    }
    
    getProgress() {
        if (this.totalSegments === 0) return 0;
        return (this.segmentsPlayed / this.totalSegments) * 100;
    }
}

// Create a global audio queue for streaming playback
const audioQueue = new AudioQueue();

/**
 * Send the recorded audio to the server for processing
 * with progressive streaming response
 */
function sendAudioToServer(audioBlob) {
    latestRequestId += 1;
    const thisRequestId = latestRequestId;
    isProcessingRequest = true;
    
    // Create FormData to send the audio file
    const formData = new FormData();
    formData.append('audio', audioBlob, 'recording.webm');
    formData.append('use_offline_tts', ttsSwitch.checked);
    
    // Add TTS engine selection
    const ttsEngine = document.getElementById('ttsEngine').value;
    formData.append('tts_engine', ttsEngine);
    
    // Add conversation ID if we have one to maintain context
    if (currentConversationId) {
        formData.append('conversation_id', currentConversationId);
        console.log('Continuing conversation:', currentConversationId);
    } else {
        console.log('Starting new conversation');
    }
    
    // Display user's audio bubble with loading state
    addMessageBubble('user', '...', true);
    
    // Use the streaming endpoint for progressive output
    fetch('/api/converse_stream/', {
        method: 'POST',
        body: formData
    })
    .then(response => {
        if (!response.ok) {
            throw new Error('Network response was not ok');
        }
        
        // Set up streaming response handling
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let streamMode = 'json'; // Start in JSON mode
        let expectedSize = 0;
        let binaryChunk = new Uint8Array(0);
        
        // Create a progressive bubble for the AI response
        const aiThinkingBubble = addMessageBubble('ai', 'Processing...', true);
        let responseBubble = null;
        
        // Reset and prepare audio queue
        audioQueue.stop();
        audioQueue.onComplete = function() {
            // Cleanup after all audio has played
            isSpeaking = false;
            currentAudio = null;
            statusIndicator.textContent = 'Listening for your voice...';
            console.log('AI response audio complete, listening for user input');
            
            // Recalibrate the background noise level
            recalibrateBackgroundNoise();
        };
        
        // Status indicators
        let messageTextReceived = false;
        let segmentsReceived = 0;
        let totalSegments = 0;
        
        // Process the stream
        function processStream() {
            return reader.read().then(({ done, value }) => {
                if (done) {
                    console.log("Stream complete");
                    aiThinkingBubble.remove();
                    isProcessingRequest = false;
                    return;
                }
                
                // Process the chunk
                const chunk = value;
                
                if (streamMode === 'json') {
                    // We're expecting JSON data
                    buffer += decoder.decode(chunk, { stream: true });
                    
                    // Process any complete JSON messages in the buffer
                    let newlineIndex;
                    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                        const line = buffer.substring(0, newlineIndex);
                        buffer = buffer.substring(newlineIndex + 1);
                        
                        if (line.trim()) {
                            try {
                                const data = JSON.parse(line);
                                
                                // Handle initial response data
                                if (!messageTextReceived && data.ai_response) {
                                    // AI response text received - update UI
                                    messageTextReceived = true;
                                    aiThinkingBubble.remove();
                                    
                                    // Create the permanent response bubble
                                    responseBubble = addMessageBubble('ai', data.ai_response);
                                    
                                    // Update transcription
                                    updateLastUserBubble(data.transcribed_text);
                                    
                                    // Save conversation ID
                                    if (data.conversation_id) {
                                        currentConversationId = data.conversation_id;
                                    }
                                    
                                    // Show tool usage if applicable
                                    if (data.tool_used) {
                                        const toolIndicator = document.createElement('div');
                                        toolIndicator.classList.add('tool-indicator');
                                        toolIndicator.innerHTML = `<small class="text-info"><i class="fas fa-tools"></i> Used: ${data.tool_used}</small>`;
                                        conversationContainer.appendChild(toolIndicator);
                                        conversationContainer.scrollTop = conversationContainer.scrollHeight;
                                    }
                                    
                                    // Set the total segments expected
                                    if (data.segments_count) {
                                        totalSegments = data.segments_count;
                                        audioQueue.setTotalSegments(totalSegments);
                                    }
                                    
                                    // Begin audio playback mode
                                    isSpeaking = true;
                                    statusIndicator.textContent = 'AI is speaking...';
                                    
                                } else if (data.segment !== undefined) {
                                    // This is segment metadata - prepare for binary audio data
                                    console.log(`Received segment ${data.segment}: ${data.text.substring(0, 20)}...`);
                                    segmentsReceived++;
                                    
                                    // Show progress
                                    const progressPercent = totalSegments > 0 ? 
                                        Math.round((segmentsReceived / totalSegments) * 100) : 0;
                                    statusIndicator.textContent = `AI is speaking... (${progressPercent}%)`;
                                    
                                    // Switch to binary mode for the next chunk
                                    streamMode = 'binary';
                                    expectedSize = data.size;
                                    binaryChunk = new Uint8Array(0);
                                    
                                } else if (data.complete) {
                                    // All segments received
                                    console.log(`Audio streaming complete: ${data.total_segments} segments in ${data.processing_time}s`);
                                }
                            } catch (e) {
                                console.error("Error parsing JSON from stream:", e, line);
                            }
                        }
                    }
                } else if (streamMode === 'binary') {
                    // We're receiving binary audio data
                    // Append to our binary chunk
                    const newChunk = new Uint8Array(binaryChunk.length + chunk.length);
                    newChunk.set(binaryChunk);
                    newChunk.set(chunk, binaryChunk.length);
                    binaryChunk = newChunk;
                    
                    // Check if we've received all expected bytes plus newline
                    if (binaryChunk.length >= expectedSize + 1) {
                        // Extract the audio data (excluding the trailing newline)
                        const audioData = binaryChunk.slice(0, expectedSize);
                        
                        // Add this segment to the audio queue for playback
                        audioQueue.addSegment(audioData);
                        
                        // Any remaining data goes back to buffer for JSON parsing
                        const remainingData = binaryChunk.slice(expectedSize + 1); // +1 to skip newline
                        buffer = decoder.decode(remainingData, { stream: true });
                        
                        // Switch back to JSON mode for next segment metadata
                        streamMode = 'json';
                    }
                }
                
                // Continue processing the stream
                return processStream();
            });
        }
        
        // Start processing the stream
        return processStream();
    })
    .catch(error => {
        console.error('Error sending audio to server:', error);
        statusIndicator.textContent = 'Error: Failed to process your message.';
        statusIndicator.classList.add('text-danger');
        
        // Resume listening after error
        setTimeout(() => {
            statusIndicator.textContent = 'Listening...';
            statusIndicator.classList.remove('text-danger');
            isProcessingRequest = false;
        }, 3000);
    });
}