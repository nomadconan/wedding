// Claude API 클라이언트 — 서버 전용. 클라이언트 컴포넌트에서 import 금지.
import Anthropic from "@anthropic-ai/sdk";

export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
export const AI_MODEL = process.env.AI_MODEL ?? "claude-sonnet-4-6";
