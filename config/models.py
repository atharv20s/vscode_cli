"""
Multi-LLM Provider Support - Use different AI models.

Supports:
- OpenRouter (default) - Access to many models
- OpenAI - GPT-4, GPT-4o
- Anthropic - Claude 3.5, Claude 3
- Ollama - Local models
- Azure OpenAI
- Custom endpoints
"""

from __future__ import annotations
from dataclasses import dataclass
from enum import Enum
from typing import Any
import os


class LLMProvider(Enum):
    """Supported LLM providers."""
    OPENROUTER = "openrouter"
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    OLLAMA = "ollama"
    AZURE = "azure"
    CUSTOM = "custom"


@dataclass
class ModelConfig:
    """Configuration for a specific model."""
    provider: LLMProvider
    model_id: str
    display_name: str
    context_window: int
    supports_tools: bool
    supports_streaming: bool
    cost_per_1k_input: float  # USD
    cost_per_1k_output: float  # USD
    best_for: list[str]  # e.g., ["coding", "reasoning", "fast"]


# Popular models registry
MODELS: dict[str, ModelConfig] = {
    # OpenRouter models (access many via one API)
    "devstral": ModelConfig(
        provider=LLMProvider.OPENROUTER,
        model_id="mistralai/devstral-2512:free",
        display_name="Devstral (Free)",
        context_window=32000,
        supports_tools=True,
        supports_streaming=True,
        cost_per_1k_input=0.0,
        cost_per_1k_output=0.0,
        best_for=["coding", "free"],
    ),
    "claude-sonnet": ModelConfig(
        provider=LLMProvider.OPENROUTER,
        model_id="anthropic/claude-3.5-sonnet",
        display_name="Claude 3.5 Sonnet",
        context_window=200000,
        supports_tools=True,
        supports_streaming=True,
        cost_per_1k_input=0.003,
        cost_per_1k_output=0.015,
        best_for=["coding", "reasoning", "long-context"],
    ),
    "claude-opus": ModelConfig(
        provider=LLMProvider.OPENROUTER,
        model_id="anthropic/claude-3-opus",
        display_name="Claude 3 Opus",
        context_window=200000,
        supports_tools=True,
        supports_streaming=True,
        cost_per_1k_input=0.015,
        cost_per_1k_output=0.075,
        best_for=["complex-reasoning", "analysis"],
    ),
    "gpt-4o": ModelConfig(
        provider=LLMProvider.OPENROUTER,
        model_id="openai/gpt-4o",
        display_name="GPT-4o",
        context_window=128000,
        supports_tools=True,
        supports_streaming=True,
        cost_per_1k_input=0.005,
        cost_per_1k_output=0.015,
        best_for=["general", "fast"],
    ),
    "gpt-4-turbo": ModelConfig(
        provider=LLMProvider.OPENROUTER,
        model_id="openai/gpt-4-turbo",
        display_name="GPT-4 Turbo",
        context_window=128000,
        supports_tools=True,
        supports_streaming=True,
        cost_per_1k_input=0.01,
        cost_per_1k_output=0.03,
        best_for=["coding", "general"],
    ),
    "deepseek-coder": ModelConfig(
        provider=LLMProvider.OPENROUTER,
        model_id="deepseek/deepseek-coder",
        display_name="DeepSeek Coder",
        context_window=64000,
        supports_tools=True,
        supports_streaming=True,
        cost_per_1k_input=0.0,
        cost_per_1k_output=0.0,
        best_for=["coding", "free"],
    ),
    "llama-70b": ModelConfig(
        provider=LLMProvider.OPENROUTER,
        model_id="meta-llama/llama-3.1-70b-instruct",
        display_name="Llama 3.1 70B",
        context_window=128000,
        supports_tools=True,
        supports_streaming=True,
        cost_per_1k_input=0.0008,
        cost_per_1k_output=0.0008,
        best_for=["general", "cheap"],
    ),
    "qwen-72b": ModelConfig(
        provider=LLMProvider.OPENROUTER,
        model_id="qwen/qwen-2.5-72b-instruct",
        display_name="Qwen 2.5 72B",
        context_window=32000,
        supports_tools=True,
        supports_streaming=True,
        cost_per_1k_input=0.0,
        cost_per_1k_output=0.0,
        best_for=["coding", "reasoning", "free"],
    ),
    
    # Direct OpenAI
    "openai-gpt4o": ModelConfig(
        provider=LLMProvider.OPENAI,
        model_id="gpt-4o",
        display_name="GPT-4o (Direct)",
        context_window=128000,
        supports_tools=True,
        supports_streaming=True,
        cost_per_1k_input=0.005,
        cost_per_1k_output=0.015,
        best_for=["general", "fast"],
    ),
    
    # Direct Anthropic
    "anthropic-sonnet": ModelConfig(
        provider=LLMProvider.ANTHROPIC,
        model_id="claude-3-5-sonnet-20241022",
        display_name="Claude 3.5 Sonnet (Direct)",
        context_window=200000,
        supports_tools=True,
        supports_streaming=True,
        cost_per_1k_input=0.003,
        cost_per_1k_output=0.015,
        best_for=["coding", "reasoning"],
    ),
    
    # Ollama (local)
    "ollama-codellama": ModelConfig(
        provider=LLMProvider.OLLAMA,
        model_id="codellama:34b",
        display_name="CodeLlama 34B (Local)",
        context_window=16000,
        supports_tools=False,
        supports_streaming=True,
        cost_per_1k_input=0.0,
        cost_per_1k_output=0.0,
        best_for=["coding", "local", "free"],
    ),
    "ollama-deepseek": ModelConfig(
        provider=LLMProvider.OLLAMA,
        model_id="deepseek-coder:33b",
        display_name="DeepSeek Coder 33B (Local)",
        context_window=16000,
        supports_tools=False,
        supports_streaming=True,
        cost_per_1k_input=0.0,
        cost_per_1k_output=0.0,
        best_for=["coding", "local", "free"],
    ),
}


@dataclass
class ProviderConfig:
    """Configuration for an LLM provider."""
    base_url: str
    api_key_env: str  # Environment variable name
    headers: dict[str, str] | None = None


PROVIDER_CONFIGS: dict[LLMProvider, ProviderConfig] = {
    LLMProvider.OPENROUTER: ProviderConfig(
        base_url="https://openrouter.ai/api/v1",
        api_key_env="OPENROUTER_API_KEY",
        headers={
            "HTTP-Referer": "https://github.com/agentic-cli",
            "X-Title": "Agentic CLI",
        },
    ),
    LLMProvider.OPENAI: ProviderConfig(
        base_url="https://api.openai.com/v1",
        api_key_env="OPENAI_API_KEY",
    ),
    LLMProvider.ANTHROPIC: ProviderConfig(
        base_url="https://api.anthropic.com/v1",
        api_key_env="ANTHROPIC_API_KEY",
    ),
    LLMProvider.OLLAMA: ProviderConfig(
        base_url="http://localhost:11434/v1",
        api_key_env="",  # No API key needed
    ),
    LLMProvider.AZURE: ProviderConfig(
        base_url="",  # Set via AZURE_OPENAI_ENDPOINT
        api_key_env="AZURE_OPENAI_API_KEY",
    ),
}


def get_model(name: str) -> ModelConfig | None:
    """Get a model configuration by name."""
    return MODELS.get(name)


def get_provider_config(provider: LLMProvider) -> ProviderConfig:
    """Get provider configuration."""
    return PROVIDER_CONFIGS.get(provider, PROVIDER_CONFIGS[LLMProvider.OPENROUTER])


def list_models(
    provider: LLMProvider | None = None,
    supports_tools: bool | None = None,
    best_for: str | None = None,
) -> list[ModelConfig]:
    """List models with optional filters."""
    results = []
    
    for model in MODELS.values():
        if provider and model.provider != provider:
            continue
        if supports_tools is not None and model.supports_tools != supports_tools:
            continue
        if best_for and best_for not in model.best_for:
            continue
        results.append(model)
    
    return results


def list_free_models() -> list[ModelConfig]:
    """List all free models."""
    return [m for m in MODELS.values() if m.cost_per_1k_input == 0]


def list_coding_models() -> list[ModelConfig]:
    """List models best for coding."""
    return [m for m in MODELS.values() if "coding" in m.best_for]


def get_api_key(provider: LLMProvider) -> str | None:
    """Get API key for a provider from environment."""
    config = get_provider_config(provider)
    if not config.api_key_env:
        return "ollama"  # Ollama doesn't need a key
    return os.getenv(config.api_key_env)


def get_base_url(provider: LLMProvider) -> str:
    """Get base URL for a provider."""
    config = get_provider_config(provider)
    
    # Handle Azure specially
    if provider == LLMProvider.AZURE:
        return os.getenv("AZURE_OPENAI_ENDPOINT", "")
    
    return config.base_url


class ModelSelector:
    """Smart model selection based on task."""
    
    @staticmethod
    def for_task(task_type: str) -> ModelConfig:
        """Select best model for a task type."""
        task_models = {
            "coding": "claude-sonnet",
            "debugging": "claude-sonnet",
            "reasoning": "claude-opus",
            "fast": "gpt-4o",
            "cheap": "llama-70b",
            "free": "devstral",
            "local": "ollama-deepseek",
        }
        
        model_name = task_models.get(task_type, "devstral")
        return MODELS.get(model_name, MODELS["devstral"])
    
    @staticmethod
    def cheapest_with_tools() -> ModelConfig:
        """Get cheapest model that supports tools."""
        tool_models = [m for m in MODELS.values() if m.supports_tools]
        return min(tool_models, key=lambda m: m.cost_per_1k_input + m.cost_per_1k_output)
    
    @staticmethod
    def best_for_coding() -> ModelConfig:
        """Get best model for coding tasks."""
        # Prefer Claude for coding
        return MODELS.get("claude-sonnet", MODELS["devstral"])
