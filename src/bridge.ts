/**
 * Single IPC surface for the UI (ADR-002: keeps Electron swap possible).
 * Add commands here as Rust handlers land — see blueprint §16.3.
 */
import { invoke } from "@tauri-apps/api/core";

export type CliDetectResult = {
  found: boolean;
  path: string | null;
  version: string | null;
  error: string | null;
};

export async function detectCli(): Promise<CliDetectResult> {
  return invoke<CliDetectResult>("detect_cli");
}

export type AcpProbeResult = {
  success: boolean;
  agentPath: string | null;
  firstResponseLine: string | null;
  stderrTail: string | null;
  error: string | null;
};

export async function probeAcp(): Promise<AcpProbeResult> {
  return invoke<AcpProbeResult>("probe_acp");
}

export type HandshakeStepResult = {
  method: string;
  success: boolean;
  responseJson: string | null;
  error: string | null;
};

export type AcpHandshakeProbeResult = {
  success: boolean;
  agentPath: string | null;
  sessionId: string | null;
  modeId: string | null;
  steps: HandshakeStepResult[];
  error: string | null;
};

export async function probeAcpHandshake(): Promise<AcpHandshakeProbeResult> {
  return invoke<AcpHandshakeProbeResult>("probe_acp_handshake");
}
