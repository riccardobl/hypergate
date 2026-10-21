#!/bin/bash
set -e
NODE_VERSION=$(cat .node-version)
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
APPIMAGE_BUILDER_VERSION=1.1.0
APPIMAGE_BUILDER_FILE="appimage-builder-${APPIMAGE_BUILDER_VERSION}-x86_64.AppImage"
APPIMAGE_BUILDER_SHA256=4b4f99cae9291d78ba12dbdabca7c0a67c72aa61eb2e5d424089171a9485e96f
APPRUN_VERSION=2.0.0
APPRUN_SHA256=c74e7e3a085c624260f0d144c02968d00fa9383f5d7fc46b32f1dc80d371d7ff
APPRUN_HOOKS_SHA256=1f64dd2161be3242f106c891b2daf27bbdd2103c20b28f57f61a56cdccb1eb6a
APPIMAGE_RUNTIME_SHA256=66f5b22f035022b8bdebb54c066aa6edc7b5db282fe6cdb372e7965f80772557
if [ "$VERSION" = "" ];
then
    VERSION=2.0
fi

bash setversion.sh

rm -Rf build || true
mkdir -p deploy
mkdir -p build/AppDir

npm ci
npm run build


wget --https-only "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" -O "build/AppDir/${NODE_ARCHIVE}"
(cd build/AppDir && sha256sum --check --strict --ignore-missing ../../node-shasums256.txt)
tar -xf "build/AppDir/${NODE_ARCHIVE}" -C build/AppDir
rm "build/AppDir/${NODE_ARCHIVE}"
mv "build/AppDir/node-v${NODE_VERSION}-linux-x64" build/AppDir/node
test "$(build/AppDir/node/bin/node --version)" = "v${NODE_VERSION}"

# Node.js 25+ requires libatomic even on systems where it is not installed.
LIBATOMIC_PATH=$(ldd build/AppDir/node/bin/node | awk '$1 == "libatomic.so.1" && $2 == "=>" { print $3 }')
test -f "$LIBATOMIC_PATH"
mkdir -p build/AppDir/usr/lib/x86_64-linux-gnu
cp -L "$LIBATOMIC_PATH" build/AppDir/usr/lib/x86_64-linux-gnu/libatomic.so.1


cp build/dist/*.js build/AppDir
cp *.json build/AppDir
cd build/AppDir
npm ci --prefix=. --omit=dev

MAX_GLIBC=2.31
while IFS= read -r native_binary; do
    required_glibc=$(readelf --version-info "$native_binary" 2>/dev/null | grep -o 'GLIBC_[0-9]\+\.[0-9]\+' | sed 's/GLIBC_//' | sort -V | tail -1)
    if [ "$required_glibc" != "" ] && [ "$(printf '%s\n%s\n' "$MAX_GLIBC" "$required_glibc" | sort -V | tail -1)" != "$MAX_GLIBC" ]; then
        echo "Native binary $native_binary requires GLIBC_$required_glibc, newer than Ubuntu 20.04 GLIBC_$MAX_GLIBC"
        exit 1
    fi
done < <(printf '%s\n' node/bin/node usr/lib/x86_64-linux-gnu/libatomic.so.1; find node_modules -path '*/prebuilds/linux-x64/*.node' -print)

cd ..

wget --https-only "https://github.com/AppImageCrafters/appimage-builder/releases/download/v${APPIMAGE_BUILDER_VERSION}/${APPIMAGE_BUILDER_FILE}" -O ./appimage-builder
echo "${APPIMAGE_BUILDER_SHA256}  ./appimage-builder" | sha256sum --check --strict
chmod +x ./appimage-builder
./appimage-builder  --appimage-extract 

mkdir -p "appimage-build/AppRun/v${APPRUN_VERSION}" appimage-build/prime
wget --https-only "https://github.com/AppImageCrafters/AppRun/releases/download/v${APPRUN_VERSION}/AppRun-Release-x86_64" -O "appimage-build/AppRun/v${APPRUN_VERSION}/AppRun-Release-x86_64"
wget --https-only "https://github.com/AppImageCrafters/AppRun/releases/download/v${APPRUN_VERSION}/libapprun_hooks-Release-x86_64.so" -O "appimage-build/AppRun/v${APPRUN_VERSION}/libapprun_hooks-Release-x86_64.so"
wget --https-only "https://github.com/AppImage/AppImageKit/releases/download/continuous/runtime-x86_64" -O appimage-build/prime/runtime-x86_64
echo "${APPRUN_SHA256}  appimage-build/AppRun/v${APPRUN_VERSION}/AppRun-Release-x86_64" | sha256sum --check --strict
echo "${APPRUN_HOOKS_SHA256}  appimage-build/AppRun/v${APPRUN_VERSION}/libapprun_hooks-Release-x86_64.so" | sha256sum --check --strict
echo "${APPIMAGE_RUNTIME_SHA256}  appimage-build/prime/runtime-x86_64" | sha256sum --check --strict


cp ../AppImageBuilder.yml .
sed -i "s/\$VERSION/$VERSION/g" AppImageBuilder.yml

squashfs-root/AppRun --recipe AppImageBuilder.yml
rm -Rf squashfs-root

cp -f *.AppImage ../deploy/hypergate
sha256sum ../deploy/hypergate | cut -d' ' -f1 > ../deploy/hypergate.sha256
