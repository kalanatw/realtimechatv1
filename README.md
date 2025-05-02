# RealTalk - Low-Latency Voice Conversation Application

RealTalk is a Django-based voice conversation application that provides a seamless, real-time voice interaction experience. It allows users to speak into their microphone, processes their speech using advanced AI models, and returns a natural-sounding spoken response.

## Features

- **Speech-to-Text**: Uses OpenAI's Whisper model for accurate speech transcription
- **Natural Language Processing**: Processes text with OpenAI's gpt-4o-mini model
- **Text-to-Speech**: Converts responses to natural-sounding speech (configurable between online and offline options)
- **Low Latency**: Optimized for minimal delay between speech and response
- **Responsive UI**: Clean, mobile-friendly interface with conversation history

## Technology Stack

- **Backend**: Python 3.x, Django 5.x
- **Frontend**: HTML5, CSS3, JavaScript (with Bootstrap 5)
- **AI Services**: OpenAI API (Whisper for STT, gpt-4o-mini for NLP)
- **Text-to-Speech**: pyttsx3 (offline), gTTS (online)

## Prerequisites

- Python 3.8 or higher
- OpenAI API key with access to Whisper and gpt-4o-mini models
- Web browser with microphone access support

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/realtalk.git
cd realtalk
```

2. Create a virtual environment and activate it:
```bash
python -m venv venv
source venv/bin/activate  # On Windows, use: venv\Scripts\activate
```

3. Install required packages:
```bash
pip install -r requirements.txt
```

4. Set up your OpenAI API key:
```bash
export OPENAI_API_KEY=your_api_key_here
```

5. Apply database migrations:
```bash
python manage.py migrate
```

6. Create a superuser (optional, for admin access):
```bash
python manage.py createsuperuser
```

7. Run the development server:
```bash
python manage.py runserver
```

8. Navigate to `http://127.0.0.1:8000` in your web browser.

## Usage

1. Click the microphone button to start recording.
2. Speak clearly into your microphone.
3. Click the button again to stop recording.
4. Wait briefly while your speech is processed.
5. Listen to the AI response.

### TTS Options

You can toggle between:
- **Offline TTS** (pyttsx3): Faster but lower quality
- **Online TTS** (gTTS): Higher quality but may have more latency

## Environment Variables

- `OPENAI_API_KEY`: Your OpenAI API key

## Project Structure

```
realtalk/
├── manage.py                 # Django management script
├── media/                    # User-uploaded and generated media files
│   ├── audio_inputs/         # Stored user voice recordings
│   └── audio_responses/      # Generated AI speech responses
├── realtalk/                 # Main Django project folder
│   ├── __init__.py
│   ├── asgi.py
│   ├── settings.py           # Project settings
│   ├── urls.py               # Main URL routing
│   └── wsgi.py
├── static/                   # Static assets
│   ├── css/
│   │   └── styles.css        # Custom CSS
│   └── js/
│       └── voiceai.js        # Voice processing JavaScript
├── templates/                # HTML templates
│   ├── base.html             # Base template
│   └── voiceai/
│       └── home.html         # Home page template
└── voiceai/                  # Voice AI app
    ├── __init__.py
    ├── admin.py              # Admin configuration
    ├── apps.py
    ├── models.py             # Data models
    ├── tests.py
    ├── urls.py               # App URL routing
    ├── utils.py              # Utility functions
    └── views.py              # View functions
```

## Performance Optimization

To achieve low latency:
- The application uses pyttsx3 for offline TTS by default which has lower latency
- Conversation history is cached for faster retrieval
- Audio processing is optimized for quick turnaround

## Troubleshooting

### Common Issues:

- **Microphone not working**: Ensure your browser has permission to access the microphone
- **API errors**: Verify your OpenAI API key is correct and has sufficient credits
- **Audio playback issues**: Check your browser's audio settings

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- OpenAI for their Whisper and GPT models
- The Django community for the excellent web framework
- Contributors to pyttsx3 and gTTS for the TTS engines