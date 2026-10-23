// Each deadline starts at the first real progress event. Repeated ready/decode
// messages cannot keep an unsuccessful session alive indefinitely.
type Stage = 'bridge' | 'capture' | 'engine' | 'sync' | 'active';
const stages: Stage[] = ['bridge', 'capture', 'engine', 'sync', 'active'];
const errors: Record<Exclude<Stage, 'active'>, string> = {
  bridge: 'Extension frame did not connect within 15 seconds',
  capture: 'No video frame was captured within 15 seconds',
  engine: 'No decoded NVIDIA output within 35 seconds; run linux-rtx-vsr doctor --gpu',
  sync: 'Decoded output did not synchronize within 15 seconds',
};
export class StartupWatchdog {
  private stage: Stage = 'bridge';
  private deadline: number;
  constructor(now: number) {
    this.deadline = now + 15000;
  }
  progress(stage: Stage, now: number) {
    if (stages.indexOf(stage) <= stages.indexOf(this.stage)) return;
    this.stage = stage;
    // The native GPU worker has a 30-second deadline. Allow it to finish cold
    // model loading and deliver/decode the first response before giving up.
    this.deadline = now + (stage === 'engine' ? 35000 : 15000);
  }
  error(now: number): string | null {
    return this.stage !== 'active' && now >= this.deadline ? errors[this.stage] : null;
  }
}
