#!/bin/bash
set -e
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


wget https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz -O build/AppDir/node.tar.xz
tar -xf build/AppDir/node.tar.xz -C build/AppDir
rm build/AppDir/node.tar.xz
mv build/AppDir/node-*-linux-x64 build/AppDir/node


cp build/dist/*.js build/AppDir
cp *.json build/AppDir
cd build/AppDir
npm ci --prefix=. --omit=dev

MAX_GLIBC=2.31
while IFS= read -r native_addon; do
    required_glibc=$(readelf --version-info "$native_addon" 2>/dev/null | grep -o 'GLIBC_[0-9]\+\.[0-9]\+' | sed 's/GLIBC_//' | sort -V | tail -1)
    if [ "$required_glibc" != "" ] && [ "$(printf '%s\n%s\n' "$MAX_GLIBC" "$required_glibc" | sort -V | tail -1)" != "$MAX_GLIBC" ]; then
        echo "Native addon $native_addon requires GLIBC_$required_glibc, newer than Ubuntu 20.04 GLIBC_$MAX_GLIBC"
        exit 1
    fi
done < <(find node_modules -path '*/prebuilds/linux-x64/*.node' -print)

cd ..

wget https://github.com/AppImageCrafters/appimage-builder/releases/download/v1.1.0/appimage-builder-1.1.0-x86_64.AppImage -O ./appimage-builder
chmod +x ./appimage-builder
./appimage-builder  --appimage-extract 


cp ../AppImageBuilder.yml .
sed -i "s/\$VERSION/$VERSION/g" AppImageBuilder.yml

squashfs-root/AppRun --recipe AppImageBuilder.yml
rm -Rf squashfs-root

cp -f *.AppImage ../deploy/hypergate
sha256sum ../deploy/hypergate | cut -d' ' -f1 > ../deploy/hypergate.sha256
