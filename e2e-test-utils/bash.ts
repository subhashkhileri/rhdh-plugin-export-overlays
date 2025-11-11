import { $ } from "zx";

$.verbose = false;
$.stdio = 'inherit'; // This makes all commands output directly to stdout
// $.prefix = "set -x;"


export { $ };