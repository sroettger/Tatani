import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.tatani.android",
  appName: "Tatani",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
  android: {
    backgroundColor: "#1a1424",
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: "#1a1424",
      showSpinner: false,
    },
    SystemBars: {
      insetsHandling: "css",
      style: "DARK",
      hidden: false,
    },
    StatusBar: {
      overlaysWebView: false,
      style: "DARK",
      backgroundColor: "#1a1424",
    },
  },
};

export default config;
