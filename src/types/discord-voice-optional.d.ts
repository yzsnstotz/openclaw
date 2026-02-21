/**
 * Stub declarations for optional Discord voice dependencies.
 * When @discordjs/voice, opusscript, or @discordjs/opus are not installed
 * (e.g. on ao user builds that do not need Discord voice), the plugin-sdk dts
 * build can still succeed. At runtime the discord/voice/manager is only
 * loaded when the Discord voice feature is enabled and deps are present.
 */
declare module "@discordjs/voice" {
  export const AudioPlayerStatus: any;
  export const EndBehaviorType: any;
  export const VoiceConnectionStatus: any;
  export function createAudioPlayer(): any;
  export function createAudioResource(...args: any[]): any;
  export function entersState(...args: any[]): Promise<any>;
  export function joinVoiceChannel(...args: any[]): any;
  export type AudioPlayer = any;
  export type VoiceConnection = any;
}
declare module "opusscript" {
  interface OpusScriptClass {
    new (rate: number, channels: number, application?: number): any;
    Application: { AUDIO?: number };
  }
  const OpusScript: OpusScriptClass;
  export = OpusScript;
}
declare module "@discordjs/opus" {
  export const OpusEncoder: { new (rate: number, channels: number): any };
}
