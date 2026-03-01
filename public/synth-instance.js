/**
 * Synth Instance Factory
 *
 * Creates one complete voice: AudioWorklet + ChannelSplitter + 3 AnalyserNodes.
 * Caller connects splitter ch0 to destination (or panner → destination).
 */

async function createSynthInstance(audioCtx) {
  const worklet = new AudioWorkletNode(audioCtx, "voice-processor", {
    outputChannelCount: [4],
  });
  const splitter = audioCtx.createChannelSplitter(4);
  worklet.connect(splitter);

  const analyserF1 = audioCtx.createAnalyser();
  analyserF1.fftSize = 512;
  analyserF1.smoothingTimeConstant = 0;
  splitter.connect(analyserF1, 1);

  const analyserF2 = audioCtx.createAnalyser();
  analyserF2.fftSize = 512;
  analyserF2.smoothingTimeConstant = 0;
  splitter.connect(analyserF2, 2);

  const analyserF3 = audioCtx.createAnalyser();
  analyserF3.fftSize = 512;
  analyserF3.smoothingTimeConstant = 0;
  splitter.connect(analyserF3, 3);

  return { worklet, splitter, analyserF1, analyserF2, analyserF3 };
}
