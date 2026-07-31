// `deno task performance` lands here instead of launching the server directly.
// Performance mode needs sudo + DNS-hijack, which live outside Deno — this
// signpost tells the operator which OS-specific wrapper to use.

const watch = Deno.args.includes("--watch") ? " --watch" : "";
const os = Deno.build.os;

const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

console.log(`${YELLOW}performance mode needs sudo + DNS-hijack — not startable as a bare deno task.${RESET}`);
console.log("");

if (os === "darwin") {
  console.log(`${CYAN}macOS:${RESET}  ./start-macos.sh performance${watch}`);
  console.log("        (handles sudo, static IP, dnsmasq launch, cleanup)");
} else if (os === "linux") {
  console.log(`${CYAN}Linux:${RESET}  arrange DNS-hijack on the router (see notes/openwrt-router.md),`);
  console.log(`        then: sudo MODE=performance deno run -A --unstable-net${watch} server.ts`);
} else {
  console.log(`${CYAN}${os}:${RESET} no scripted wrapper — arrange sudo + DNS-hijack manually, then:`);
  console.log(`        MODE=performance deno run -A --unstable-net${watch} server.ts`);
}

console.log("");
console.log("If dnsmasq is already managed elsewhere, run the raw command above.");
