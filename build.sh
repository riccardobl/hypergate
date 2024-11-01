#!/bin/bash
set -e
if [ "$VERSION" = "" ];
then
    VERSION=2.0
fi

bash setversion.sh

rm -Rf build || true
rm -Rf dist || true
mkdir -p deploy
mkdir -p build/AppDir

npm run build


wget https://nodejs.org/dist/v18.13.0/node-v18.13.0-linux-x64.tar.xz -O build/AppDir/node.tar.xz
tar -xf build/AppDir/node.tar.xz -C build/AppDir
rm build/AppDir/node.tar.xz
mv build/AppDir/node-*-linux-x64 build/AppDir/node


cp dist/*.js build/AppDir
cp *.json build/AppDir
cd build/AppDir
npm i --prefix=.

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
