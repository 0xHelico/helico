# CRE pindah ke lapisan yield

Ditulis 8 September, sebelum kodenya, setelah pertanyaan yang seharusnya kutanya sendiri:
*bukannya CRE sekarang tugasnya yield optimizer?*

## Apa yang sebenarnya terjadi

Bukan. Diperiksa ke kodenya, bukan diingat:

```
grep -rl "aave|Aave|lending|yield|MandateSwap|swapExactIn"  packages/plugins/cre/src/   → kosong
```

Yang CRE kirim on-chain hari ini: `positionOf`, `lastActionAt`, `isActive`, lalu `recenter` ke
`HelicoVault`. Config produksinya berisi `positionManager`, `stateView`, `poolId`,
`maxPoolFeePips`. Itu **bot re-centre posisi Uniswap v4**, seluruhnya.

Sementara yang kami ceritakan: modal nganggur bekerja di Aave, agent swap lewat mandat Aqua, CRE
yang memutuskan. Dua produk dalam satu submission, dan yang satu tidak menyambung ke yang lain.
Itu yang bikin juri 1inch bilang *"quite general"*.

## Keputusan

**CRE pindah ke lapisan yield.** Dia memutuskan di mana modal nganggur duduk dan menggerakkannya,
bukan lagi menggeser rentang LP. `HelicoVault` dan seluruh jalur Uniswap v4 ikut dihapus.

## Masalah yang harus dipecahkan dulu

`HelicoAccount.execute` itu **owner-only**. CRE bukan pemilik, jadi hari ini dia tidak punya cara
menggerakkan akun sama sekali. Menaikkan CRE jadi pemilik kedua bukan jawaban: seluruh arsitektur
ini dibangun supaya satu kunci tidak bisa mengambil uang orang.

Jawabannya bukan "boleh memanggil apa saja atas nama pemilik", tapi **satu tindakan yang bentuknya
tidak bisa merugikan**:

> Agent boleh memindahkan aset akun **antara dompetnya sendiri dan pasar lending yang pemiliknya
> izinkan**. Tidak ada penerima dalam panggilan itu. Uang tidak punya jalan keluar.

Turunannya, dan semuanya harus ada di kode:

- **Tujuannya selalu `address(this)`.** `supply(..., onBehalfOf: account)` dan
  `withdraw(..., to: account)`. Tidak ada parameter penerima yang bisa diisi agent.
- **Pool harus ada di daftar pemiliknya.** Agent tidak boleh memperkenalkan pasar baru; itu cara
  menguras lewat kontrak yang berperilaku seperti pasar.
- **Pemilik boleh mencabut agent kapan saja**, dan pencabutan berlaku seketika.
- **Pintu darurat tidak tersentuh.** `escape` tetap milik proxy dan tetap hanya pemiliknya.

Yang **tidak** didapat agent, ditulis supaya tidak merayap nanti: tidak boleh transfer keluar,
tidak boleh approve siapa pun, tidak boleh ship atau dock mandat, tidak boleh upgrade.

## Kenapa ini cukup untuk ceritanya

Modal user duduk di kontraknya sendiri. CRE melihat berapa yang menganggur, memutuskan berapa yang
harus bekerja, dan memindahkannya — tanpa pernah bisa memindahkannya ke tempat lain. Lalu ketika
agent melakukan swap lewat mandat Aqua, `_cover` menarik kekurangannya dari pasar yang sama di
dalam transaksi yang sama.

Satu kalimat, satu produk: **uang user tidak pernah menganggur, dan tidak pernah meninggalkan
kontraknya kecuali dia sendiri yang menyuruh.**

## Yang ikut dihapus

`HelicoVault`, `Mandate.sol`, `IPoolManager`, `IPositionManager`, `IStateView`, `TickMath`,
`Deploy.s.sol`, `Rehearse.s.sol`, dan tujuh berkas test yang menggantung padanya. Ini bukan
bersih-bersih — ini menghapus jalur produk yang lama, dan dilakukan hanya karena penggantinya
sudah berdiri.

## Yang rencana ini tidak lakukan

- **Tidak memberi CRE kuasa atas dana.** Kalau suatu hari ada tuntutan fitur yang butuh itu,
  itu keputusan baru dengan dokumennya sendiri, bukan pelebaran diam-diam dari yang ini.
- **Tidak memindahkan keputusan yield ke on-chain.** Kontrak menegakkan bentuknya; *berapa* dan
  *kapan* tetap keputusan enclave, dan itu justru klaim Chainlink kami.
