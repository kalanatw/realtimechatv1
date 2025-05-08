/**
 * WebSocket client for RealTalk voice conversation application.
 * This module handles WebSocket connections for real-time voice communication.
 */

class VoiceWebSocketClient {
    /**
     * Initialize the WebSocket client.
     * 
     * @param {Object} options Configuration options
     * @param {string} options.baseUrl Base URL for WebSocket connections (default: window.location.host)
     * @param {boolean} options.useStreaming Whether to use streaming mode (default: true)
     * @param {boolean} options.useOfflineTTS Whether to use offline TTS (default: true)
     * @param {string} options.ttsEngine TTS engine to use (default: 'kokoro')
     * @param {Function} options.onOpen Callback when connection opens
     * @param {Function} options.onClose Callback when connection closes
     * @param {Function} options.onError Callback when error occurs
     * @param {Function} options.onTranscription Callback when transcription is received
     * @param {Function} options.onAIResponse Callback when AI response is received
     * @param {Function} options.onAudio Callback when audio data is received
     * @param {Function} options.onComplete Callback when conversation is complete
     */
    constructor(options = {}) {
        // Set default options
        this.options = {
            baseUrl: options.baseUrl || window.location.host,
            useStreaming: options.useStreaming !== undefined ? options.useStreaming : true,
            useOfflineTTS: options.useOfflineTTS !== undefined ? options.useOfflineTTS : true,
            ttsEngine: options.ttsEngine || 'kokoro',
            onOpen: options.onOpen || (() => {}),
            onClose: options.onClose || (() => {}),
            onError: options.onError || ((error) => { console.error('WebSocket error:', error); }),
            onTranscription: options.onTranscription || (() => {}),
            onAIResponse: options.onAIResponse || (() => {}),
            onAudio: options.onAudio || (() => {}),
            onTTSSegment: options.onTTSSegment || (() => {}),
            onComplete: options.onComplete || (() => {})
        };
        
        // WebSocket connection
        this.socket = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectTimeout = null;
        
        // Conversation state
        this.conversationId = null;
        
        // Audio processing state
        this.pendingAudioMetadata = null;
        this.isProcessingRequest = false;
        
        // Initialize connection
        this.connect();
    }
    
    /**
     * Connect to the WebSocket server.
     */
    connect() {
        // Clear any existing reconnection timeout
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        
        // Determine WebSocket URL based on current page protocol
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const endpoint = this.options.useStreaming ? 'ws/voiceai/stream/' : 'ws/voiceai/converse/';
        const wsUrl = `${protocol}//${this.options.baseUrl}/${endpoint}`;
        
        console.log(`Connecting to WebSocket at ${wsUrl}`);
        
        try {
            this.socket = new WebSocket(wsUrl);
            
            // Set up event handlers
            this.socket.onopen = this._handleOpen.bind(this);
            this.socket.onclose = this._handleClose.bind(this);
            this.socket.onerror = this._handleError.bind(this);
            this.socket.onmessage = this._handleMessage.bind(this);
            
            // Binary type for audio data
            this.socket.binaryType = 'arraybuffer';
        } catch (error) {
            console.error('Error creating WebSocket connection:', error);
            this._scheduleReconnect();
        }
    }
    
    /**
     * Disconnect from the WebSocket server.
     */
    disconnect() {
        if (this.socket && this.isConnected) {
            this.socket.close(1000, 'Client disconnected');
        }
        
        // Clear any pending reconnection
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
    }
    
    /**
     * Send metadata to the server.
     * This should be called after connection is established.
     */
    sendMetadata() {
        if (!this.isConnected) {
            console.warn('Cannot send metadata: WebSocket not connected');
            return false;
        }
        
        const metadata = {
            type: 'metadata',
            use_offline_tts: this.options.useOfflineTTS,
            tts_engine: this.options.ttsEngine,
            conversation_id: this.conversationId
        };
        
        this.socket.send(JSON.stringify(metadata));
        console.log('Sent metadata to server:', metadata);
        return true;
    }
    
    /**
     * Set the conversation ID for maintaining context between exchanges.
     * 
     * @param {string} id The conversation ID
     */
    setConversationId(id) {
        this.conversationId = id;
        console.log('Set conversation ID:', id);
    }
    
    /**
     * Send audio data to the server for processing.
     * 
     * @param {Blob} audioBlob Audio data as a Blob
     * @returns {boolean} Whether the audio was sent successfully
     */
    sendAudio(audioBlob) {
        if (!this.isConnected) {
            console.warn('Cannot send audio: WebSocket not connected');
            return false;
        }
        
        if (this.isProcessingRequest) {
            console.warn('Cannot send audio: Already processing a request');
            return false;
        }
        
        this.isProcessingRequest = true;
        
        // Convert Blob to ArrayBuffer and send
        const reader = new FileReader();
        reader.onload = () => {
            try {
                this.socket.send(reader.result);
                console.log('Sent audio data to server, size:', audioBlob.size);
            } catch (error) {
                console.error('Error sending audio data:', error);
                this.isProcessingRequest = false;
                this.options.onError(error);
            }
        };
        
        reader.onerror = (error) => {
            console.error('Error reading audio data:', error);
            this.isProcessingRequest = false;
            this.options.onError(error);
        };
        
        reader.readAsArrayBuffer(audioBlob);
        return true;
    }
    
    /**
     * Request text-to-speech conversion for a specific text.
     * This is only applicable in streaming mode.
     * 
     * @param {string} text The text to convert to speech
     * @returns {boolean} Whether the request was sent successfully
     */
    requestTTS(text) {
        if (!this.isConnected || !this.options.useStreaming) {
            console.warn('Cannot request TTS: WebSocket not connected or not in streaming mode');
            return false;
        }
        
        const request = {
            type: 'tts_request',
            text: text
        };
        
        this.socket.send(JSON.stringify(request));
        console.log('Sent TTS request for text:', text.substring(0, 50) + '...');
        return true;
    }
    
    /**
     * Send a ping to test the connection.
     * 
     * @returns {boolean} Whether the ping was sent successfully
     */
    ping() {
        if (!this.isConnected) {
            console.warn('Cannot ping: WebSocket not connected');
            return false;
        }
        
        const ping = {
            type: 'ping',
            timestamp: Date.now()
        };
        
        this.socket.send(JSON.stringify(ping));
        console.log('Sent ping to server');
        return true;
    }
    
    /**
     * Handle WebSocket open event.
     * 
     * @param {Event} event The open event
     * @private
     */
    _handleOpen(event) {
        console.log('WebSocket connection established');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        
        // Send metadata after connection
        this.sendMetadata();
        
        // Notify via callback
        this.options.onOpen();
    }
    
    /**
     * Handle WebSocket close event.
     * 
     * @param {CloseEvent} event The close event
     * @private
     */
    _handleClose(event) {
        console.log(`WebSocket connection closed: ${event.code} - ${event.reason}`);
        this.isConnected = false;
        this.isProcessingRequest = false;
        
        // Attempt to reconnect if not closed cleanly
        if (event.code !== 1000) {
            this._scheduleReconnect();
        }
        
        // Notify via callback
        this.options.onClose(event);
    }
    
    /**
     * Handle WebSocket error event.
     * 
     * @param {Event} event The error event
     * @private
     */
    _handleError(event) {
        console.error('WebSocket error:', event);
        
        // Notify via callback
        this.options.onError(event);
    }
    
    /**
     * Handle WebSocket message event.
     * 
     * @param {MessageEvent} event The message event
     * @private
     */
    _handleMessage(event) {
        // Handle binary data (audio)
        if (event.data instanceof ArrayBuffer) {
            this._handleBinaryMessage(event.data);
            return;
        }
        
        // Handle text data (JSON)
        try {
            const data = JSON.parse(event.data);
            this._handleJsonMessage(data);
        } catch (error) {
            console.error('Error parsing WebSocket message:', error);
            this.options.onError(error);
        }
    }
    
    /**
     * Handle binary message (audio data).
     * 
     * @param {ArrayBuffer} data The binary data
     * @private
     */
    _handleBinaryMessage(data) {
        // In streaming mode, this is a TTS segment
        if (this.options.useStreaming) {
            // Notify via callback (for streaming TTS playback)
            this.options.onTTSSegment(data);
            return;
        }
        
        // In regular mode, check if we have pending audio metadata
        if (this.pendingAudioMetadata) {
            console.log(`Received audio data: ${data.byteLength} bytes`);
            
            // Create a Blob from the ArrayBuffer
            const audioBlob = new Blob([data], { type: 'audio/mp3' });
            
            // Create a URL for the Blob
            const audioUrl = URL.createObjectURL(audioBlob);
            
            // Notify via callback
            this.options.onAudio(audioUrl, audioBlob);
            
            // Clear pending metadata
            this.pendingAudioMetadata = null;
            
            // Mark request as complete
            this.isProcessingRequest = false;
            this.options.onComplete();
        } else {
            console.warn('Received binary data without metadata');
        }
    }
    
    /**
     * Handle JSON message.
     * 
     * @param {Object} data The JSON data
     * @private
     */
    _handleJsonMessage(data) {
        console.log('Received WebSocket message:', data.type);
        
        switch (data.type) {
            case 'metadata_received':
                // Metadata acknowledged
                console.log('Server acknowledged metadata');
                break;
                
            case 'transcription':
                // Transcription result
                console.log('Received transcription:', data.text);
                this.options.onTranscription(data.text);
                break;
                
            case 'ai_response':
                // AI response text
                console.log('Received AI response:', data.text);
                
                // Update conversation ID if provided
                if (data.conversation_id) {
                    this.conversationId = data.conversation_id;
                }
                
                // Notify via callback
                this.options.onAIResponse(data.text, data.conversation_id, data.tool_used);
                break;
                
            case 'audio_metadata':
                // Audio metadata (before binary audio data)
                console.log('Received audio metadata, size:', data.size);
                this.pendingAudioMetadata = data;
                break;
                
            case 'tts_segment':
                // Streaming TTS segment metadata
                console.log(`Received TTS segment ${data.segment}: ${data.text}`);
                // Binary data with the actual audio will follow
                break;
                
            case 'tts_complete':
                // TTS streaming complete
                console.log('TTS streaming complete, segments:', data.segments);
                this.isProcessingRequest = false;
                this.options.onComplete();
                break;
                
            case 'pong':
                // Response to ping
                const latency = Date.now() - data.timestamp;
                console.log(`Received pong, latency: ${latency}ms`);
                break;
                
            case 'error':
                // Error from server
                console.error('Received error from server:', data.message);
                this.options.onError(new Error(data.message));
                this.isProcessingRequest = false;
                break;
                
            default:
                console.warn('Unknown message type:', data.type);
        }
    }
    
    /**
     * Schedule a reconnection attempt.
     * 
     * @private
     */
    _scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error(`Failed to reconnect after ${this.reconnectAttempts} attempts`);
            return;
        }
        
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        console.log(`Scheduling reconnection attempt ${this.reconnectAttempts + 1} in ${delay}ms`);
        
        this.reconnectTimeout = setTimeout(() => {
            this.reconnectAttempts++;
            this.connect();
        }, delay);
    }
}

// Export the client class
window.VoiceWebSocketClient = VoiceWebSocketClient;