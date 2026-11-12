"""One JSON-mode text completion seam for all Director Agent targets."""
from __future__ import annotations

import json
import os
from urllib import request
from typing import Callable


# 创作助手是短结构化 JSON 任务，默认用 Flash；Pro 只作为显式覆盖或 .env_llm 选择。
DEFAULT_JSON_MODEL = "doubao-seed-1-6-flash-250828"


def configured_model() -> str:
    """This seam's effective model: `.env_llm` wins, then the Flash default."""
    return os.getenv("DOUBAO_LLM_MODEL") or DEFAULT_JSON_MODEL


def complete_json(
    system_prompt: str,
    user_prompt: str,
    max_tokens: int,
    *,
    model: str | None = None,
    temperature: float = 0.7,
    client_factory: Callable | None = None,
) -> dict:
    model = model or configured_model()
    messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
    ]
    if client_factory is not None:
        completion = client_factory().client.chat.completions.create(
            model=model, messages=messages, max_tokens=max_tokens,
            temperature=temperature, response_format={"type": "json_object"},
        )
        choice = completion.choices[0]
        finish_reason = getattr(choice, "finish_reason", None)
        content = str(choice.message.content or "").strip()
    else:
        key = next((os.getenv(name) for name in ("DOUBAO_LLM_API_KEY", "DOUBAO_API_KEY", "ARK_API_KEY") if os.getenv(name)), None)
        if not key:
            raise ValueError("缺少豆包 API key；设置 DOUBAO_LLM_API_KEY")
        endpoint = (os.getenv("DOUBAO_LLM_ENDPOINT") or "https://ark.cn-beijing.volces.com/api/v3").rstrip("/")
        payload = json.dumps({"model": model, "messages": messages, "max_tokens": max_tokens,
                              "temperature": temperature, "response_format": {"type": "json_object"}}).encode()
        req = request.Request(endpoint + "/chat/completions", data=payload,
                              headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        with request.urlopen(req, timeout=120) as response:
            choice = json.load(response)["choices"][0]
        finish_reason = choice.get("finish_reason")
        content = str(choice["message"].get("content") or "").strip()
    if finish_reason == "length":
        raise ValueError("LLM JSON 响应被截断，请重试或缩小请求规模")
    try:
        value = json.loads(content)
    except json.JSONDecodeError as error:
        raise ValueError(f"LLM response is not valid JSON: {error}") from error
    if not isinstance(value, dict):
        raise ValueError("LLM JSON response must be an object")
    return value
