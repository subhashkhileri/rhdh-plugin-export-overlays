import { $ } from "zx";

$.verbose = true;
// $.stdio = 'inherit'; // This makes all commands output directly to stdout but prevents capturing output
// $.prefix = "set -x;"


export { $ };