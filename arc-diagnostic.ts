#!/usr/bin/env -S deno run --allow-read --allow-write

// Diagnostic tool to test arc iii serial communication using ^^ protocol

const devicePath = Deno.args[0] || "/dev/cu.usbmodem808212311";

console.log(`Opening ${devicePath}...`);
const device = await Deno.open(devicePath, { read: true, write: true });
console.log("Device opened successfully");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Start read loop
(async () => {
  const buf = new Uint8Array(1024);
  while (true) {
    try {
      const n = await device.read(buf);
      if (n === null) {
        console.log("EOF - device closed");
        break;
      }
      if (n > 0) {
        const text = decoder.decode(buf.subarray(0, n));
        console.log(`<< ${text.replace(/\r/g, "\\r").replace(/\n/g, "\\n\n")}`);
      }
    } catch (e) {
      console.error("Read error:", e);
      break;
    }
  }
})();

// Wait for device to settle
await new Promise(r => setTimeout(r, 1000));

console.log("\n=== Testing ^^ protocol commands ===\n");

// Test 1: Clear script
console.log(">> ^^c (clear script)");
await device.write(encoder.encode("^^c\r\n"));
await new Promise(r => setTimeout(r, 500));

// Test 2: Reboot environment
console.log(">> ^^z (reboot environment)");
await device.write(encoder.encode("^^z\r\n"));
await new Promise(r => setTimeout(r, 500));

// Test 3: Simple print command
console.log(">> print('HELLO')");
await device.write(encoder.encode("print('HELLO')\r\n"));
await new Promise(r => setTimeout(r, 500));

// Test 4: Override enc callback
console.log(">> enc = function(n, d) print(string.format('ENC:%d:%d', n, d)) end");
await device.write(encoder.encode("enc = function(n, d) print(string.format('ENC:%d:%d', n, d)) end\r\n"));
await new Promise(r => setTimeout(r, 500));

// Test 5: Override key callback
console.log(">> key = function() end");
await device.write(encoder.encode("key = function() end\r\n"));
await new Promise(r => setTimeout(r, 500));

// Test 6: Confirm ready
console.log(">> print('ARC_READY')");
await device.write(encoder.encode("print('ARC_READY')\r\n"));
await new Promise(r => setTimeout(r, 500));

console.log("\n=== Commands sent. Now try turning encoders and pressing button ===");
console.log("Press Ctrl+C to exit\n");

// Keep running to see responses
await new Promise(() => {});
