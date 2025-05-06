#!/usr/bin/env python3
"""
This script helps install and set up Kokoro TTS for your RealTalk project.
It will install the necessary Python packages and system dependencies.
"""
import os
import sys
import subprocess
import platform

def print_step(message):
    """Print a formatted step message"""
    print(f"\n{'='*80}\n{message}\n{'='*80}")

def print_success(message):
    """Print a success message"""
    print(f"\n✅ {message}")

def print_error(message):
    """Print an error message"""
    print(f"\n❌ {message}")

def run_command(command, shell=False):
    """Run a command and print its output"""
    try:
        result = subprocess.run(
            command,
            shell=shell,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        print(result.stdout)
        return True
    except subprocess.CalledProcessError as e:
        print_error(f"Command failed with exit code {e.returncode}")
        print(f"Error output: {e.stderr}")
        return False

def install_python_dependencies():
    """Install the required Python packages"""
    print_step("Installing Python dependencies for Kokoro")
    
    packages = ["kokoro>=0.9.4", "soundfile", "numpy"]
    return run_command([sys.executable, "-m", "pip", "install"] + packages)

def install_system_dependencies():
    """Install the required system dependencies based on platform"""
    print_step("Installing system dependencies for Kokoro")
    
    system = platform.system()
    if system == "Darwin":  # macOS
        print("Detected macOS platform")
        if run_command(["which", "brew"], shell=False):
            return run_command(["brew", "install", "espeak-ng"])
        else:
            print_error("Homebrew not found. Please install Homebrew first: https://brew.sh/")
            return False
    elif system == "Linux":
        print("Detected Linux platform")
        return run_command(["apt-get", "install", "-y", "espeak-ng"], shell=True)
    elif system == "Windows":
        print("Detected Windows platform")
        print("Please install espeak-ng manually from: https://github.com/espeak-ng/espeak-ng/releases")
        return True  # Continue anyway
    else:
        print_error(f"Unsupported platform: {system}")
        return False

def test_kokoro():
    """Test if Kokoro works correctly"""
    print_step("Testing Kokoro TTS installation")
    
    try:
        # Test if we can import the modules
        print("Importing Kokoro and dependencies...")
        from kokoro import KPipeline
        import soundfile as sf
        import torch
        
        # Test if we can create a pipeline
        print("Creating Kokoro pipeline...")
        pipeline = KPipeline(lang_code='a')  # 'a' for American English
        
        # Test with a short sample text
        print("Generating test speech...")
        test_text = "This is a test of the Kokoro text-to-speech system."
        generator = pipeline(test_text, voice='af_heart')
        
        # Process the generator output
        output_file = "kokoro_test.wav"
        for i, (gs, ps, audio) in enumerate(generator):
            print(f"Generated segment {i}: '{gs}'")
            sf.write(output_file, audio, 24000)
            
        print_success(f"Test speech generated and saved to {os.path.abspath(output_file)}")
        
        return True
    except ImportError as e:
        print_error(f"Import error: {e}")
        return False
    except Exception as e:
        print_error(f"Error testing Kokoro: {e}")
        return False

def main():
    """Main function"""
    print_step("Setting up Kokoro TTS for RealTalk")
    
    # Install Python dependencies
    if not install_python_dependencies():
        print_error("Failed to install Python dependencies")
        return False
    
    # Install system dependencies
    if not install_system_dependencies():
        print_error("Failed to install system dependencies")
        return False
    
    # Test Kokoro
    if not test_kokoro():
        print_error("Kokoro test failed. Please check the error messages above")
        return False
    
    print_success("Kokoro TTS has been successfully set up for RealTalk")
    print("\nYou can now use Kokoro as your default TTS engine in the RealTalk app.")
    return True

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
