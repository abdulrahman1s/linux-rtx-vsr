# Browser integration

Choose your browser when installing a release:

```sh
sh scripts/install.sh --browser helium --add-to-path
```

To register another browser later:

```sh
linux-rtx-vsr integration install --browser vivaldi
```

Load the printed extension directory through your browser's extensions page with **Developer mode → Load unpacked**. All registrations use the same exported extension and native backend. Only one tab can enhance at a time.

## Browser names

| Browser                                                          | `--browser` value      | Directory under `~/.config`           |
| ---------------------------------------------------------------- | ---------------------- | ------------------------------------- |
| Chromium / ungoogled Chromium with the standard profile location | `chromium`             | `chromium`                            |
| Google Chrome                                                    | `chrome`               | `google-chrome`                       |
| Google Chrome Beta                                               | `chrome-beta`          | `google-chrome-beta`                  |
| Google Chrome Dev                                                | `chrome-dev`           | `google-chrome-unstable`              |
| Brave                                                            | `brave`                | `BraveSoftware/Brave-Browser`         |
| Brave Beta                                                       | `brave-beta`           | `BraveSoftware/Brave-Browser-Beta`    |
| Brave Nightly                                                    | `brave-nightly`        | `BraveSoftware/Brave-Browser-Nightly` |
| Brave Origin                                                     | `brave-origin`         | `BraveSoftware/Brave-Origin`          |
| Brave Origin Nightly                                             | `brave-origin-nightly` | `BraveSoftware/Brave-Origin-Nightly`  |
| Microsoft Edge                                                   | `edge`                 | `microsoft-edge`                      |
| Microsoft Edge Beta                                              | `edge-beta`            | `microsoft-edge-beta`                 |
| Microsoft Edge Dev                                               | `edge-dev`             | `microsoft-edge-dev`                  |
| Vivaldi                                                          | `vivaldi`              | `vivaldi`                             |
| Vivaldi Snapshot                                                 | `vivaldi-snapshot`     | `vivaldi-snapshot`                    |
| Helium                                                           | `helium`               | `net.imput.helium`                    |

The native manifest is placed in `NativeMessagingHosts` under the selected directory. `XDG_CONFIG_HOME` overrides `~/.config`; Chrome and Chromium also honor `CHROME_CONFIG_HOME`. Register each browser you use, then check the connection in the extension popup.

These options provide native messaging registration. Real enhanced playback has been tested only on the combinations in the [validation record](validation.md). Other builds still need compatible AV1 WebCodecs decoding, video capture, and Web Audio. Flatpak and Snap browser packages are unsupported.

Directory references: [Chromium's profile documentation](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md), [KeePassXC's native host installer](https://github.com/keepassxreboot/keepassxc/blob/develop/src/browser/NativeMessageInstaller.cpp), [Brave's native host discovery](https://github.com/brave/brave-core/blob/master/app/brave_main_delegate.cc), and [Bitwarden's Linux registrations, including Helium](https://github.com/bitwarden/clients/blob/main/apps/desktop/src/main/native-messaging.main.ts). Helium also provides a [Chrome registry fallback](https://github.com/imputnet/helium/blob/main/patches/helium/core/scan-chrome-native-messaging-hosts.patch).

## Custom profiles and other Chromium browsers

For a browser with a different native messaging directory, supply the absolute directory explicitly:

```sh
linux-rtx-vsr integration install \
  --manifest-dir /absolute/path/to/browser/NativeMessagingHosts
```

Some branded browsers search their compiled default location even with `--user-data-dir`; consult the browser's native messaging documentation and use the popup backend check to confirm discovery. The manifest belongs under the browser's user-data root, usually above the `Default` profile folder. Do not change extension IDs or copy a different browser's profile.

Remove a registration with the same selector you installed:

```sh
linux-rtx-vsr integration remove --browser helium
# For a custom location:
linux-rtx-vsr integration remove \
  --manifest-dir /absolute/path/to/browser/NativeMessagingHosts
```

## NixOS and Home Manager

Both modules offer `browsers.chromium`, `chrome`, `brave`, `edge`, `vivaldi`, and `helium`. Enable the corresponding entry instead of running the CLI installer. Helium defaults to registration only (`package = null`); set `browsers.helium.package` to your Helium derivation if you also want the module to install it. See the [module guide](nix.md#recommended-declarative-modules).
