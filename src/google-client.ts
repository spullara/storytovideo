import { GoogleGenAI } from "@google/genai";

let googleClient: GoogleGenAI | null = null;

export function getGoogleClient(): GoogleGenAI {
  if (!googleClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is not set");
    }
    googleClient = new GoogleGenAI({ apiKey });
  }
  return googleClient;
}

