// What the app shows before it touches the file system: decided from the "full-access" permission state,
// read without asking. Anything but "granted" waits for a click (the first fs call would otherwise ask at load).
export function accessGate(state) {
  if (state === "granted") return { boot: true };
  if (state === "prompt") {
    return {
      boot: false, title: "Allow full access", action: "request", button: "Allow access",
      message: "Six Minutes Studio needs full access to read your project folders on S:.",
    };
  }
  if (state === "denied") {
    return {
      boot: false, title: "Full access is off", action: "manage", button: "Open permissions",
      message: "Full access is turned off for Six Minutes Studio, so it can't read your project folders on S:. Turn it on in the app's permissions.",
    };
  }
  return {
    boot: false, title: "Full access isn't available", action: "recheck", button: "Try again",
    message: "Full access isn't available in this window, so Six Minutes Studio can't read your project folders on S:. If the app is still signing in, try again in a moment; otherwise open the installed app from the Claude desktop app.",
  };
}
