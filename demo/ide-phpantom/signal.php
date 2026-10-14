<?php

function average(array $samples): float {
    return array_sum($samples) / count($samples);
}

function amplitude(): float {
    return "high";
}

echo average([0.2, 0.8, -0.4, 0.5, 1.0]);
