"""
Agent implementation for voice-based interactions using the OpenAI Agents library.
This module provides the core agent functionality with memory, tools, and conversation management.
"""
import logging
import asyncio
import os
import json
from typing import List, Dict, Any, Optional
import uuid

from django.conf import settings
from openai import OpenAI
from agents import Agent as OpenAIAgent, Runner

from .tools import get_weather, get_datetime, calculate, set_reminder
from .models import Conversation
from .logger import logger

class VoiceAgent:
    """
    Voice agent that uses OpenAI Agents to process user requests and generate responses.
    This agent maintains conversation context and can use tools to perform actions.
    """
    
    # Store conversation memories keyed by conversation_id
    conversation_memories = {}
    
    def __init__(self, api_key: Optional[str] = None):
        """
        Initialize the voice agent with tools and memory
        
        Args:
            api_key: Optional OpenAI API key (defaults to the one in settings)
        """
        self.api_key = api_key or settings.OPENAI_API_KEY
        self.client = OpenAI(api_key=self.api_key)
        
        # Ensure API key is also set as an environment variable for the Runner
        os.environ["OPENAI_API_KEY"] = self.api_key
        
        # System prompt that defines the agent's personality and behavior
        self.system_prompt = """
        You are a helpful, friendly voice assistant with useful capabilities. 
        When speaking to users:
        -Speak in english only
        - Be conversational, concise, and natural
        - Keep responses under 3 sentences when possible
        - Use tools when appropriate to answer factual questions
        - For calculation, weather, time, or reminder questions, use the appropriate tool
        - Avoid long explanations unless the user asks for more details
        - Your responses will be spoken aloud, so keep them brief and clear
        - Remember previous parts of the conversation when responding
        """
        
        # Initialize agent with tools
        self.agent = OpenAIAgent(
            name="Assistant",
            instructions=self.system_prompt,
            model="gpt-4o-mini",
            #tools=[get_weather, get_datetime, calculate, set_reminder]
        )
        
        logger.info("VoiceAgent initialized with tools: Weather, DateTime, Calculator, Reminder")
    
    def process_message(self, message: str, conversation_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Process a user message and generate a response
        
        Args:
            message: User's message text
            conversation_id: Optional ID of existing conversation for context
            
        Returns:
            Dictionary with response text, conversation ID, and tool usage information
        """
        logger.info(f"Processing message: '{message}' (conversation_id: {conversation_id})")
        
        # Log the tools available to the agent
        tool_names = ["get_weather", "get_datetime", "calculate", "set_reminder"]
        logger.info(f"Agent created with tools: {', '.join(tool_names)}")
        
        # Set up tool tracking
        tool_used = None
        
        # Generate a new conversation ID if we don't have one
        if not conversation_id:
            conversation_id = str(uuid.uuid4())
            logger.info(f"Generated new conversation ID: {conversation_id}")
        
        # Get conversation history for context enhancement
        conversation_history = self._get_conversation_history(conversation_id)
        
        # Enhance the message with conversation history if available
        enhanced_message = message
        if conversation_history:
            history_text = "\n".join([
                f"Previous conversation:\n{history}\n" 
                for history in conversation_history
            ])
            enhanced_message = f"{history_text}\nCurrent request: {message}"
            logger.info(f"Enhanced message with {len(conversation_history)} previous exchanges")
        
        # Run the agent on the user message
        try:
            logger.info("Running agent on user message...")
            
            # Using the async Runner with asyncio to run the agent
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            
            try:
                # Run the agent using the Runner class
                result = loop.run_until_complete(Runner.run(
                    self.agent, 
                    enhanced_message  # Use the enhanced message with context
                ))
                response_text = result.final_output
                logger.info(f"Agent response: '{response_text}'")
                
                # Update conversation history with this exchange
                self._update_conversation_history(conversation_id, message, response_text)
                
                # Check for tool usage in the trace metadata if available
                trace_data = getattr(result, 'trace', {})
                tools_used = []
                
                # Try to extract tool usage information from the trace
                try:
                    for step in trace_data.get('steps', []):
                        if step.get('type') == 'tool_call' and step.get('name'):
                            tools_used.append(step.get('name'))
                except (AttributeError, TypeError):
                    pass
                
                if tools_used:
                    tool_used = tools_used[0]
                    logger.info(f"Tool used by agent: {tool_used}")
                else:
                    logger.info("No tools were used by the agent")
            finally:
                loop.close()
            
            return {
                "response": response_text,
                "conversation_id": conversation_id,
                "tool_used": tool_used
            }
            
        except Exception as e:
            logger.error(f"Error processing message with agent: {str(e)}")
            return {
                "response": "I'm sorry, I encountered an error while processing your request. Please try again.",
                "conversation_id": conversation_id,
                "tool_used": None
            }
    
    def _get_conversation_history(self, conversation_id: str) -> List[str]:
        """
        Get formatted conversation history for the given ID
        
        Args:
            conversation_id: The conversation ID
            
        Returns:
            List of formatted conversation exchanges
        """
        if conversation_id not in self.conversation_memories:
            logger.info(f"Creating new conversation history for ID: {conversation_id}")
            self.conversation_memories[conversation_id] = []
            return []
        
        logger.info(f"Found existing conversation history for ID: {conversation_id}")
        formatted_history = []
        
        for exchange in self.conversation_memories[conversation_id]:
            formatted_history.append(f"User: {exchange['user']}\nAssistant: {exchange['assistant']}")
        
        return formatted_history
    
    def _update_conversation_history(self, conversation_id: str, user_message: str, assistant_message: str):
        """
        Update the conversation memory with the latest exchange
        
        Args:
            conversation_id: The conversation ID
            user_message: The user's message
            assistant_message: The assistant's response
        """
        if conversation_id not in self.conversation_memories:
            self.conversation_memories[conversation_id] = []
        
        # Add the new exchange to memory
        self.conversation_memories[conversation_id].append({
            'user': user_message,
            'assistant': assistant_message
        })
        
        # Keep only the last 10 exchanges to prevent context from getting too large
        if len(self.conversation_memories[conversation_id]) > 10:
            self.conversation_memories[conversation_id] = self.conversation_memories[conversation_id][-10:]
        
        logger.info(f"Updated conversation history for ID: {conversation_id}, " +
                   f"history size: {len(self.conversation_memories[conversation_id])} exchanges")