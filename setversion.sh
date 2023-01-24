#!/bin/bash

set -e
if [ "$VERSION" = "" ] || [ "$VERSION" = "SNAPSHOT" ] || [ "$VERSION" = "snapshot" ];
then
    VERSION=0.0.0-snapshot
fi
jq ".version=\"$VERSION\"" package.json  > tmp_package.json
mv -f tmp_package.json package.json 