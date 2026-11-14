from pathlib import Path

from setuptools import find_packages, setup

ROOT = Path(__file__).parent
README = ROOT / "README.md"

setup(
    name="ath-ide-agent",
    version="1.0.0",
    description="ATH IDE Python agent runtime and terminal assistant",
    long_description=README.read_text(encoding="utf-8") if README.exists() else "",
    long_description_content_type="text/markdown",
    packages=find_packages(
        include=[
            "Agent", "Agent.*",
            "CLIENT", "CLIENT.*",
            "config", "config.*",
            "context", "context.*",
            "hooks", "hooks.*",
            "prompts", "prompts.*",
            "safety", "safety.*",
            "tools", "tools.*",
            "ui", "ui.*",
            "utils", "utils.*",
        ]
    ),
    py_modules=["main"],
    install_requires=[
        "click>=8.1.7,<9",
        "openai>=1.0.0,<4",
        "rich>=13.7.0,<15",
        "requests>=2.31.0,<3",
        "ddgs>=9.0.0,<10",
        "httpx>=0.27.0,<1",
    ],
    extras_require={
        "dev": ["pytest>=8.0.0,<9"],
    },
    entry_points={
        "console_scripts": [
            "ath-agent=main:main",
        ],
    },
    python_requires=">=3.10",
    license="MIT",
    classifiers=[
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Operating System :: POSIX :: Linux",
        "Environment :: Console",
    ],
)
