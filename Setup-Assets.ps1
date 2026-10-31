$ErrorActionPreference = 'Stop'
# Retained as an optional integrity check; running the demo requires no setup.
$hashes = @{
    'assets\indicxlit-encoder.onnx' = '9AEE8D96AF0DB3B1D3475AE144E57B289654938E6FFA90E1A651D7AAB7285BC3'
    'assets\indicxlit-decoder.onnx' = '5ACC737B18BBC485D9E521580BBC770176AF309A8FBC99BE72E79571F425EBA3'
    'assets\source-vocab.json' = '9247A8CDB3E7EEDB9EA275FF69D4C8FB86C99E97CE655CD59F9F7A98C53B923A'
    'assets\target-vocab.json' = 'A6DA0EC58A503CA34152D1985544B43873144119BFD7980EEE084AB195037286'
    'assets\tamil-recompose.js' = '1EAF49F203DB518384351F79BEB852071A4B1D8AA3DAAAADEA4E466FACF7A1F6'
    'runtime\ort.wasm.min.js' = 'C6BC9F8E1D0ECC3983A57910E6A30B2230A512BCD2E0207CD64306459C3DE7B4'
    'runtime\ort-wasm-simd-threaded.mjs' = '90A557D15C02BAC4504D95B67F431D8594635ED2A0A62A7F2CD83D090FF91D3E'
    'runtime\ort-wasm-simd-threaded.wasm' = '45EAEE27761AD883742A8D4B8FCE1538D60CE43B51ADF1726FAFCCC59B8C1A15'
    'licenses\IndicXlit-LICENSE.txt' = '763144522D0515ACD475F496D0E0DF4E44030688A432E7A21FE46E8A4501188B'
    'licenses\ONNX-Runtime-LICENSE.txt' = '2F07C72751AED99790B8A4869CF2311DF85A860B22DED05FA22803587A48922C'
    'licenses\ONNX-Runtime-ThirdPartyNotices.txt' = 'E9E90971A8E75A9A8AC0C6412E29C1202D079998389915AA485F46C816C3B4CC'
}
foreach ($name in $hashes.Keys) {
    $path = Join-Path $PSScriptRoot $name
    if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Missing committed file: $name. Restore it from this repository."
    }
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $hashes[$name]) {
        throw "Unexpected bundled file hash: $name. Restore the exact committed file."
    }
}
Write-Host 'All committed models, vocabularies, helper, runtime and notices verified. No files downloaded or copied.'
