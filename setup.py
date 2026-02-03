from setuptools import setup, find_packages

setup(
    name="ethereum-monitor",
    version="0.1.0",
    packages=find_packages(),
    install_requires=[
        "click>=8.0.0",
        "requests>=2.25.0",
    ],
    entry_points={
        "console_scripts": [
            "eth-monitor=ethereum_monitor.main:cli",
        ],
    },
    author="Agentic CLI Team",
    description="CLI tool for monitoring Ethereum wallet addresses",
    python_requires=">=3.7",
)