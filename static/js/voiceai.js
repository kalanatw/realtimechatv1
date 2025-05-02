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
        });
    });
    
    // Remove auto-initialization on page load
    // initializeAudio();
    
    // Remove manual button event listeners (recordButton, resetButton)
    
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
     */
    function calibrateBackgroundNoise() {
        let calibrationCount = 0;
        const maxCalibrationSamples = 30; // About 1 second of calibration
        console.log('Calibrating background noise...');
        const calibrationInterval = setInterval(() => {
            if (calibrationCount >= maxCalibrationSamples) {
                clearInterval(calibrationInterval);
                
                // Calculate the average background noise level
                backgroundNoiseLevel = calibrationSamples.reduce((a, b) => a + b, 0) / calibrationSamples.length;
                console.log('Background noise level calibrated:', backgroundNoiseLevel);
                
                // Add a small buffer to avoid false triggers
                backgroundNoiseLevel += 2;
                
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
        analyser.smoothingTimeConstant = 0.2; // Reduced for faster response to speech
        
        // Connect the source to the analyser
        source.connect(analyser);
        
        // Create a processor to monitor audio levels
        scriptProcessor = audioContext.createScriptProcessor(1024, 1, 1);
        analyser.connect(scriptProcessor);
        scriptProcessor.connect(audioContext.destination);
        
        // Set up processing to detect voice activity
        scriptProcessor.onaudioprocess = function() {
            console.log('onaudioprocess running');
            // Always analyze audio for voice activity
            const array = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(array);
            
            // Get average volume level
            const average = getAverageVolume(array);
            
            // Get speech frequency signature (human voice is typically 85-255 Hz)
            const voiceFrequencySignature = getVoiceFrequencySignature(array);
            
            // Debug logs for audio processing
            console.log('Audio process: avg', average, 'bgNoise', backgroundNoiseLevel, 'voiceSig', voiceFrequencySignature, 'isRecording', isRecording, 'isListening', isListening);
            
            // For visualization
            if (isRecording) {
                updateVolumeIndicator(average);
            }
            
            // If we're recording, handle silence detection
            if (isRecording) {
                // Is the current audio above background noise and has speech frequencies?
                const isSpeakingNow = (average > backgroundNoiseLevel + 5) && (voiceFrequencySignature > 0.3);
                
                if (isSpeakingNow) {
                    // Reset silence detection
                    if (silenceTimer !== null) {
                        clearTimeout(silenceTimer);
                        silenceTimer = null;
                    }
                    consecutiveSilenceCount = 0;
                } else {
                    // Count consecutive silence frames
                    consecutiveSilenceCount++;
                    
                    // Only trigger silence timeout if we've had multiple silent frames
                    // This helps with momentary gaps in speech
                    if (consecutiveSilenceCount > 15 && !silenceTimer) {
                        silenceTimer = setTimeout(() => {
                            if (isRecording) {
                                console.log('Silence detected, stopping recording');
                                stopRecording();
                            }
                        }, silenceTimeout);
                    }
                }
            } 
            // If we're not recording but listening, detect when to start
            else if (isListening && !isSpeaking && !isProcessingRequest) {
                // Is this audio likely to be speech?
                console.log('Detection check: avg', average, 'bgNoise', backgroundNoiseLevel, 'voiceSig', voiceFrequencySignature);
                const isProbablySpeech = (average > backgroundNoiseLevel + 1) && (voiceFrequencySignature > 0.1);
                if (isProbablySpeech) {
                    speakingTriggerCount++;
                    if (speakingTriggerCount >= 2) { // Lowered to 2 frames for faster trigger
                        console.log('Speech detected, starting recording. Volume:', average, 'Voice signature:', voiceFrequencySignature);
                        startRecording();
                        speakingTriggerCount = 0;
                    }
                } else {
                    speakingTriggerCount = 0;
                }
            }
        };
    }
    
    /**
     * Calculate average volume from frequency data
     */
    function getAverageVolume(array) {
        let values = 0;
        const length = array.length;
        
        // Use the frequency data to calculate volume
        for (let i = 0; i < length; i++) {
            values += array[i];
        }
        
        return values / length;
    }
    
    /**
     * Extract the voice frequency signature to better distinguish speech from noise
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
            totalSum += frequencyData[i];
            
            // Calculate the frequency of this bin
            const frequency = i * binSize;
            
            // Check if this frequency is in the human voice range (85-255 Hz)
            if (frequency >= 85 && frequency <= 255) {
                voiceSum += frequencyData[i];
            }
        }
        
        // Return the ratio of voice frequencies to all frequencies
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
        
        // Send the audio to the server
        sendAudioToServer(audioBlob);
        
        // Reset audio chunks for next recording
        audioChunks = [];
    }
    
    /**
     * Start the recording process
     */
    function startRecording() {
        if (isRecording || isProcessingRequest) return; // Prevent duplicate starts and only start if no request is in progress
        
        isRecording = true;
        audioChunks = [];
        
        // Start with a 10ms timeslice to get data chunks more frequently
        mediaRecorder.start(10);
        
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
        
        // Reset silence counter
        consecutiveSilenceCount = 0;
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
     */
    function sendAudioToServer(audioBlob) {
        latestRequestId += 1;
        const thisRequestId = latestRequestId;
        isProcessingRequest = true; // Set flag to indicate request is in progress
        // Create FormData to send the audio file
        const formData = new FormData();
        formData.append('audio', audioBlob, 'recording.webm');
        formData.append('use_offline_tts', ttsSwitch.checked);
        
        // Add conversation ID if we have one to maintain context
        if (currentConversationId) {
            formData.append('conversation_id', currentConversationId);
            console.log('Continuing conversation:', currentConversationId);
        } else {
            console.log('Starting new conversation');
        }
        
        // Display user's audio bubble with loading state
        addMessageBubble('user', '...', true);
        
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
                // Only update UI if this is the latest request
                if (thisRequestId === latestRequestId) {
                    // Update the user's message with the transcription
                    updateLastUserBubble(data.transcribed_text);
                    
                    // Show AI is thinking
                    const aiThinkingBubble = addMessageBubble('ai', '...', true);
                    
                    // Add the AI's response after a small delay to simulate thinking
                    setTimeout(() => {
                        // Remove the thinking bubble
                        aiThinkingBubble.remove();
                        
                        // Add the actual response
                        addMessageBubble('ai', data.ai_response);
                        
                        // Play the audio response
                        playAudioResponse(data.audio_url);
                        
                        // Save the conversation ID for context in future exchanges
                        if (data.conversation_id) {
                            currentConversationId = data.conversation_id;
                            console.log('Conversation ID updated:', currentConversationId);
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
                        }
                        
                        // Update topics list
                        updateTopicsList(data.ai_response);
                    }, 600); // Simulate a brief thinking time for more natural conversation flow
                    
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
     */
    function playAudioResponse(audioUrl) {
        // Set speaking state to true
        isSpeaking = true;
        statusIndicator.textContent = 'AI is speaking...';
        
        // Create and configure audio element
        const audio = new Audio(audioUrl);
        currentAudio = audio;
        
        // When audio ends, resume listening immediately
        audio.onended = function() {
            isSpeaking = false;
            currentAudio = null;
            statusIndicator.textContent = 'Listening for your voice...';
            console.log('AI response finished, listening for user input');
            
            // Remove any existing continue buttons if present
            const continueButtons = document.querySelectorAll('.continue-button');
            continueButtons.forEach(button => button.remove());
            
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
        audio.play()
            .catch(error => {
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

    // Initial conversation greeting
    addMessageBubble('ai', 'How can I help you today? I\'m listening for your voice.');
});