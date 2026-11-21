#!/usr/bin/env bash
# Builds RemoteHunt APK with plain Android SDK tools (aapt, dx, apksigner). No Gradle needed.
set -euo pipefail
cd "$(dirname "$0")"
# macOS: tools installed in ~/.local (Java 17, Android SDK, dx wrapper) are used automatically
if [ -z "${JAVA_HOME:-}" ] && [ -d "$HOME/.local/jdk17/Contents/Home" ]; then export JAVA_HOME="$HOME/.local/jdk17/Contents/Home"; fi
[ -n "${JAVA_HOME:-}" ] && export PATH="$JAVA_HOME/bin:$PATH"
[ -d "$HOME/.local/bin" ] && export PATH="$HOME/.local/bin:$PATH"
SDK_JAR=${ANDROID_JAR:-/usr/lib/android-sdk/platforms/android-23/android.jar}
[ -f "$SDK_JAR" ] || SDK_JAR="$HOME/.local/android-sdk/platforms/android-23/android.jar"
OUT=build; rm -rf $OUT; mkdir -p $OUT/gen $OUT/classes
aapt package -f -m -J $OUT/gen -M AndroidManifest.xml -S res -I "$SDK_JAR"
javac -nowarn -Xlint:-options -source 8 -target 8 -encoding UTF-8 -bootclasspath "$SDK_JAR" \
  -d $OUT/classes $(find src $OUT/gen -name '*.java')
dalvik-exchange --dex --output=$OUT/classes.dex $OUT/classes
aapt package -f -M AndroidManifest.xml -S res -A assets -I "$SDK_JAR" -F $OUT/unsigned.apk
(cd $OUT && aapt add -f unsigned.apk classes.dex >/dev/null)
zipalign -f 4 $OUT/unsigned.apk $OUT/aligned.apk
[ -f debug.keystore ] || keytool -genkeypair -keystore debug.keystore -storepass android -keypass android \
  -alias rh -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=RemoteHunt Personal" >/dev/null 2>&1
apksigner sign --ks debug.keystore --ks-pass pass:android --key-pass pass:android --out $OUT/RemoteHunt.apk $OUT/aligned.apk
apksigner verify --print-certs $OUT/RemoteHunt.apk | head -3
ls -la $OUT/RemoteHunt.apk
