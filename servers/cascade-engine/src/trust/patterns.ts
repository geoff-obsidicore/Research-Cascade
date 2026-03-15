/**
 * Instruction Pattern Detection — Regex rules for prompt injection defense
 *
 * SpamAssassin-inspired weighted scoring:
 * - Each pattern has a weight (negative = suspicious, positive = benign)
 * - Total score indicates injection likelihood
 *
 * Designed to catch MINJA-style attacks while allowing legitimate content.
 */

export interface PatternMatch {
  pattern: string;
  weight: number;
  matched: string;
  category: 'directive' | 'override' | 'impersonation' | 'encoding' | 'benign';
}

export interface PatternResult {
  totalScore: number;
  matches: PatternMatch[];
  riskLevel: 'clean' | 'suspicious' | 'dangerous';
}

interface PatternRule {
  regex: RegExp;
  weight: number;
  category: PatternMatch['category'];
  name: string;
}

const RULES: PatternRule[] = [
  // --- Directive patterns (attempts to instruct the LLM) ---
  { regex: /\b(ignore|disregard|forget)\b.{0,30}\b(previous|above|prior|instructions?)\b/i, weight: -0.40, category: 'override', name: 'OVERRIDE_ATTEMPT' },
  { regex: /\b(you (are|must|should|will)|your (role|task|purpose|job))\b/i, weight: -0.15, category: 'directive', name: 'DIRECTIVE_KEYWORD' },
  { regex: /\b(system\s*prompt|system\s*message|hidden\s*instruction)\b/i, weight: -0.35, category: 'override', name: 'SYSTEM_PROMPT_REFERENCE' },
  { regex: /\b(instead|rather|actually|correction)\b.{0,20}\b(do|say|output|respond|return)\b/i, weight: -0.20, category: 'directive', name: 'REDIRECT_ATTEMPT' },
  { regex: /\b(new\s+instructions?|updated?\s+instructions?|revised?\s+instructions?)\b/i, weight: -0.30, category: 'override', name: 'INSTRUCTION_INJECTION' },

  // --- Impersonation patterns ---
  { regex: /\[\s*(system|admin|user|assistant)\s*\]/i, weight: -0.25, category: 'impersonation', name: 'ROLE_TAG' },
  { regex: /<\s*(system|admin|user|assistant)\s*>/i, weight: -0.25, category: 'impersonation', name: 'ROLE_XML_TAG' },
  { regex: /\bI\s+am\s+(an?\s+)?(AI|assistant|model|language\s+model)\b/i, weight: -0.15, category: 'impersonation', name: 'AI_IMPERSONATION' },

  // --- Encoding/obfuscation patterns ---
  { regex: /[^\x00-\x7F]{10,}/g, weight: -0.10, category: 'encoding', name: 'UNICODE_BLOCK' },
  { regex: /\\x[0-9a-f]{2}/gi, weight: -0.15, category: 'encoding', name: 'HEX_ENCODING' },
  { regex: /\\u[0-9a-f]{4}/gi, weight: -0.10, category: 'encoding', name: 'UNICODE_ESCAPE' },
  { regex: /base64|atob|btoa/i, weight: -0.10, category: 'encoding', name: 'BASE64_REFERENCE' },

  // --- Benign academic patterns (positive signals) ---
  { regex: /\b(et\s+al\.|doi:|arxiv:|isbn|issn)\b/i, weight: 0.10, category: 'benign', name: 'ACADEMIC_REFERENCE' },
  { regex: /\b(figure|table|section|appendix)\s+\d+/i, weight: 0.05, category: 'benign', name: 'ACADEMIC_STRUCTURE' },
  { regex: /\b(methodology|hypothesis|experiment|results|conclusion)\b/i, weight: 0.05, category: 'benign', name: 'SCIENTIFIC_TERM' },
  { regex: /https?:\/\/[^\s]+/g, weight: 0.02, category: 'benign', name: 'URL_PRESENCE' },
];

/**
 * Scan text for instruction injection patterns.
 * Returns negative total score (more negative = more suspicious).
 */
export function detectInstructionPatterns(text: string): PatternResult {
  const matches: PatternMatch[] = [];
  let totalScore = 0;

  for (const rule of RULES) {
    const regex = new RegExp(rule.regex.source, rule.regex.flags);
    let match: RegExpExecArray | null;

    // Reset lastIndex for global regexes
    regex.lastIndex = 0;

    while ((match = regex.exec(text)) !== null) {
      matches.push({
        pattern: rule.name,
        weight: rule.weight,
        matched: match[0].slice(0, 60), // Truncate for safety
        category: rule.category,
      });
      totalScore += rule.weight;

      // For non-global regexes, only match once
      if (!rule.regex.global) break;
    }
  }

  // Additional heuristic: very long text with few semantic tokens is suspicious
  const wordCount = text.split(/\s+/).length;
  const uniqueWords = new Set(text.toLowerCase().split(/\s+/)).size;
  if (wordCount > 50 && uniqueWords / wordCount < 0.3) {
    matches.push({
      pattern: 'LOW_VOCABULARY_DIVERSITY',
      weight: -0.15,
      matched: `${uniqueWords}/${wordCount} unique words`,
      category: 'encoding',
    });
    totalScore -= 0.15;
  }

  let riskLevel: PatternResult['riskLevel'];
  if (totalScore >= -0.1) riskLevel = 'clean';
  else if (totalScore >= -0.4) riskLevel = 'suspicious';
  else riskLevel = 'dangerous';

  return { totalScore, matches, riskLevel };
}
