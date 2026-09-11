"""Convert supplied fonts; retain originals and name/license/weight metadata.
Run: python -m pip install --target .font-tools fonttools brotli
     python scripts/convert-fonts.py
"""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".font-tools"))
from fontTools.ttLib import TTFont

SOURCES = [
    ("PPNeueMachina-Ultrabold.otf", "neue-machina-ultrabold.woff2"),
    ("PPNeueMachina-Regular.otf", "neue-machina-regular.woff2"),
    ("GeneralSans-Regular.woff", "general-sans-regular.woff2"),
    ("GeneralSans-Medium.woff", "general-sans-medium.woff2"),
    ("GeneralSans-Semibold.woff", "general-sans-semibold.woff2"),
]
destination = ROOT / "src/assets/fonts"
destination.mkdir(parents=True, exist_ok=True)
for source, output in SOURCES:
    font = TTFont(ROOT / "src/app/fonts" / source)
    original_names = [(n.nameID, n.toUnicode()) for n in font["name"].names]
    original_weight = font["OS/2"].usWeightClass
    font.flavor = "woff2"
    font.save(destination / output)
    converted = TTFont(destination / output)
    assert [(n.nameID, n.toUnicode()) for n in converted["name"].names] == original_names
    assert converted["OS/2"].usWeightClass == original_weight
    print(f"{output}: weight {original_weight}; name and license metadata preserved")
