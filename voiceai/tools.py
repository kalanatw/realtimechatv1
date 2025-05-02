"""
Tools for the Voice Agent to use during interactions.
These tools allow the agent to perform actions and retrieve information.
"""
import json
import requests
import datetime
import logging
import random
from typing import Dict, Any, Optional

from agents import function_tool
from .logger import logger

@function_tool
def get_weather(location: str) -> str:
    """
    Get the current weather for a specified location
    
    Args:
        location: The location to get weather for (city or city, country)
        
    Returns:
        String with weather information
    """
    logger.info(f"WeatherTool: Getting weather for {location}")
    try:
        # For demo purposes, return mock data instead of making actual API call
        logger.info("WeatherTool: Returning mock weather data for demo")
        choices = ["sunny", "cloudy", "rainy", "snowy"]
        weather = random.choice(choices)
        temp = random.randint(60, 85)
        return f"It's currently {temp}°F in {location} with {weather} conditions. The humidity is 45% and wind speed is 10 mph from the northwest."
    except Exception as e:
        logger.error(f"WeatherTool error: {str(e)}")
        return f"Sorry, I couldn't get the weather for {location} due to an error."

@function_tool
def get_datetime(timezone: str = "local") -> str:
    """
    Get the current date and time
    
    Args:
        timezone: The timezone to get time for (defaults to local)
        
    Returns:
        String with current date and time
    """
    logger.info(f"DateTimeTool: Getting date/time for timezone {timezone}")
    try:
        now = datetime.datetime.now()
        date_str = now.strftime("%A, %B %d, %Y")
        time_str = now.strftime("%I:%M %p")
        return f"It is currently {date_str} at {time_str}."
    except Exception as e:
        logger.error(f"DateTimeTool error: {str(e)}")
        return "Sorry, I couldn't get the current date and time due to an error."

@function_tool
def calculate(expression: str) -> str:
    """
    Perform a mathematical calculation
    
    Args:
        expression: Mathematical expression as a string
        
    Returns:
        String with the result of the calculation
    """
    logger.info(f"CalculatorTool: Calculating {expression}")
    try:
        # Use eval with extreme caution in production!
        # This is simplified for the example - you should use a safer alternative
        allowed_names = {"abs": abs, "round": round}
        result = eval(expression, {"__builtins__": {}}, allowed_names)
        return f"The result of {expression} is {result}."
    except Exception as e:
        logger.error(f"CalculatorTool error: {str(e)}")
        return f"Sorry, I couldn't calculate '{expression}'. Please check the format and try again."

@function_tool
def set_reminder(message: str, date: str, time: str) -> str:
    """
    Set a reminder for a specific date and time
    
    Args:
        message: The reminder message
        date: The date for the reminder (e.g., "May 3, 2025")
        time: The time for the reminder (e.g., "3:00 PM")
        
    Returns:
        Confirmation message
    """
    logger.info(f"ReminderTool: Setting reminder '{message}' for {date} at {time}")
    # This is a mock implementation - in a real app, you would store this in a database
    return f"I've set a reminder for '{message}' on {date} at {time}."