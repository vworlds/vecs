import { Module, ON_STORE } from "@vworlds/vecs";
import type Phaser from "phaser";
import { Music, Sound } from "@vworlds/vecs-phaser";

/**
 * The live looping playback bound to a `Music` entity. Client-local wrapper
 * component (the concrete Phaser sound class varies by sound manager, so the
 * playback cannot be attached under its own class like GameObjects are).
 */
export class MusicPlayback {
  public sound!: Phaser.Sound.BaseSound;
}

export interface AudioModuleConfig {
  readonly scene: Phaser.Scene;
}

/**
 * Plays replicated audio: `Sound` fires one-shots on every set (including
 * entry); `Music` keeps a looping playback alive exactly while the component
 * is present — stopped and disposed through the `MusicPlayback` remove hook,
 * so entity destruction and baseline resets clean up for free.
 *
 * Audio assets come from the catalog (`AssetManager.getAudio` server-side,
 * queued by `loadAssets` client-side) and are keyed by resource id.
 */
export class AudioModule extends Module<AudioModuleConfig> {
  public init(config: AudioModuleConfig): void {
    const { scene } = config;
    const world = this.world;

    world.component(MusicPlayback).onRemove((_entity, playback) => {
      playback.sound.stop();
      playback.sound.destroy();
    });
    world.component(Music).onRemove((entity) => entity.remove(MusicPlayback));

    world
      .system("phaser.audio.sound")
      .with(Sound)
      .phase(ON_STORE)
      .update({ watch: Sound, onEnter: true }, (_entity, sound) => {
        scene.sound.play(String(sound.asset), { rate: sound.rate, volume: sound.volume });
      });

    world
      .system("phaser.audio.music.start")
      .with(Music)
      .without(MusicPlayback)
      .phase(ON_STORE)
      .enter([Music], (entity, [music]) => {
        const sound = scene.sound.add(String(music.asset), {
          loop: music.loop,
          volume: music.volume,
        });
        sound.play();
        const playback = new MusicPlayback();
        playback.sound = sound;
        entity.attach(playback);
      });

    // Volume/loop changes apply to the live playback without restarting.
    world
      .system("phaser.audio.music.update")
      .with(Music, MusicPlayback)
      .phase(ON_STORE)
      .update({ watch: Music, inject: [MusicPlayback] }, (_entity, music, [playback]) => {
        const sound = playback.sound as Phaser.Sound.BaseSound & {
          setLoop(value: boolean): unknown;
          setVolume(value: number): unknown;
        };
        sound.setVolume(music.volume);
        sound.setLoop(music.loop);
      });
  }
}
