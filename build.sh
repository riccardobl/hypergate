#!/bin/bash
set -e
if [ "$VERSION" = "" ];
then
    VERSION=1.0
fi

rm -Rf build || true
mkdir -p deploy
mkdir -p build/AppDir
cd build/AppDir
wget https://nodejs.org/dist/v18.13.0/node-v18.13.0-linux-x64.tar.xz -O node.tar.xz
tar -xf node.tar.xz
rm node.tar.xz
mv node* node
cp ../../*.js .
cp ../../*.json .
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
