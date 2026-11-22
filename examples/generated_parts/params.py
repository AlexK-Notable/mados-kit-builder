"""MADOS kit: what to generate.  The joint numbers themselves live in src/mados_kit/generators.py, each with
a [measured] note; they were read from the official CC0 files in upstream/ and tested
against stock parts (tools/)."""

# Each entry: name -> (kind, settings).  Kinds and their settings:
#   socket_block   size=(x, y, z) mm, multiples of 20; faces=(...) optional
#                  a solid box with the stock socket pattern cut into its faces
#   channel_block  length mm (multiple of 20, >= 40); across=(nx, nz) sticks side by side
#                  the hollow, threaded-channel block like the stock Plain Block
#   twist_block    length mm (multiple of 20, >= 40); strength 0..9; far_end None, "cw" or "ccw"
#                  a channelled block with four twist plugs on its near end
#   hinge          length mm (multiple of 20); strength 0..9
#   cover          width, length mm (multiples of 10); strength 0..9
#   wrap_cover     panels; length mm; strength 0..9; panel_width mm (default 20)
# Any entry may add scale=<factor>: the finished part is enlarged, joints included.  A scaled
# part only mates with parts made at the same scale; its fit has not been test-printed.
PARTS = {
    "socket_block_40": ("socket_block", dict(size=(40.0, 40.0, 40.0))),
    "channel_60": ("channel_block", dict(length=60.0)),
    "channel_40_2x2": ("channel_block", dict(length=40.0, across=(2, 2))),
    "channel_40_x2": ("channel_block", dict(length=40.0, scale=2.0)),
    "twist_60": ("twist_block", dict(length=60.0, strength=4)),
    "twist_40_double": ("twist_block", dict(length=40.0, strength=3, far_end="ccw")),
    "hinge_60": ("hinge", dict(length=60.0, strength=3)),
    "cover_30x40": ("cover", dict(width=30.0, length=40.0, strength=4)),
    "wrap_3x40": ("wrap_cover", dict(panels=3, length=40.0, strength=4)),
    "wrap_4x60": ("wrap_cover", dict(panels=4, length=60.0, strength=4)),
}

# Stock parts used as references: a generated part of the same kind and size must match
# its stock twin.  generated-only volume is allowed up to the embossed part number that
# the generators leave out; stock-only volume must be near zero.
STOCK_TWINS = {
    ("channel_block", 40.0): "MADOS-20BB",
    ("channel_block", 60.0): "MADOS-20BC",
    ("channel_block", 80.0): "MADOS-20BD",
    ("twist_block", 40.0): "MADOS-20AB",
    ("twist_block", 60.0): "MADOS-20AC",
    ("twist_block", 80.0): "MADOS-20AD",
}
TWIN_EXTRA_MAX = 8.0     # mm3 [measured: 2.8 - 3.1 on plain blocks (the filled part number), 4.1 - 5.1 on twist blocks]
TWIN_MISSING_MAX = 2.0   # mm3 [measured: 0.02 on plain blocks, 0.4 - 1.4 on twist blocks]

# Share of the official socket cutters' volume allowed to overlap a generated part.
# [measured: 0.0005 from meshing the same curved surfaces twice; a misplaced cutter gives > 0.02]
SOCKET_FREE_MAX = 0.002
# Printable volume the example parts must fit, mm. Set this to your own printer.
BED = (220.0, 220.0, 250.0)   # [a common bed size, not any particular machine]
BED_MARGIN = 5.0
